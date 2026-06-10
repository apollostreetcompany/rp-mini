# Bead 15 — Per-call dynamic root targeting on all MCP tools

You are the implementation engineer for bead 15 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-15-dynamic-roots` in a dedicated git worktree.

## Why

A 3-agent benchmark showed rp-mini losing on its home turf: the MCP server binds `process.cwd()` at launch, so an agent whose session sits in workspace A could not use rp-mini against a sibling checkout B. The agent fell back to raw shell and rp-mini's engine never ran. This bead makes every tool callable against any target root.

## Owned paths (you may modify ONLY these)

- `packages/server/src/index.ts`
- `packages/server/src/server.test.ts` and/or a new `packages/server/src/dynamicRoots.test.ts`
- `packages/server/src/cli.ts` ONLY if needed to keep `serve`/`tool` dispatch aligned (behavior of existing CLI commands must not change)
- `packages/core/src/config/index.ts` (new config keys only)
- `packages/core/src/config/*.test.ts` (config tests)
- `README.md` (config table + tools section rows for the new param/keys)

## Spec

1. Add an optional `root` parameter (`z.string().min(1).optional()`) to ALL 10 tool input schemas in `toolDefinitions` (`packages/server/src/index.ts`). Keep `.strict()`. Description: absolute path of an alternative workspace root to target for this call.
2. New config keys in `packages/core/src/config`: `dynamic_roots.enabled` (boolean, default `true`) and `dynamic_roots.max` (positive int, default `4`), env vars `RP_MINI_DYNAMIC_ROOTS_ENABLED` / `RP_MINI_DYNAMIC_ROOTS_MAX`, following the existing layered-config patterns exactly.
3. Per-call resolution in the server (`handleTool` or a thin wrapper around it):
   - No `root` arg → behavior identical to today (primary config/roots/stateRef).
   - `root` provided and (after `realpath` normalization) equal to one of the served roots → primary context.
   - Otherwise, if `dynamic_roots.enabled`: get-or-create a per-root context from an LRU cache (capacity `dynamic_roots.max`, keyed by realpath) holding that root's `Config` and its own `SelectionState` ref. The dynamic root's config must honor that workspace's own `rp-mini.config.json` the same way `cli.js tool <workspace> ...` does today (see `loadConfig(absoluteRoot, { roots: [absoluteRoot] })` in `cli.ts`); document in a code-adjacent comment only what cannot be read from the code.
   - Selections for a dynamic root persist under `<root>/.rp-mini/sessions` exactly like primary selections (same sessionId), so LRU eviction must be safe: evict, re-target the same root, selection state reloads from disk.
4. Validation errors are structured tool responses, never throws: `{ error: { code, message } }` with codes `root_not_absolute`, `root_not_found`, `root_not_directory`, `dynamic_roots_disabled`.
5. Both entry points must support it identically: `createRpMiniServer` tool handlers AND `runRpMiniTool` (the CLI `tool` command dispatches through it).
6. Update the 10 tool descriptions to mention `root`, and add README rows (`dynamic_roots.enabled`, `dynamic_roots.max`; one sentence in the Tools intro about per-call `root`).

## Out of scope

- Skills, shared-prompts, cc-plugin, codex-plugin (bead 16 owns those).
- `packages/core/src/search` (bead 17 owns it).
- `.mcp.json`, `mcp-servers.toml`, install.sh.
- Daemon/keep-alive work.

## TDD (mandatory, in this order)

Write failing tests FIRST, run them to confirm they fail for the right reason, then implement minimally. Required scenarios:

1. Server constructed with roots=[tempA]; `file_search` with `root: tempB` returns tempB's files; same call without `root` still returns tempA's.
2. `read_file` and `get_file_tree` with `root: tempB` operate on tempB.
3. `manage_selection` add with `root: tempB`, then `workspace_context` (tokens include) with `root: tempB` reflects that selection; tempA's selection state is unaffected.
4. LRU safety: with `dynamic_roots.max: 1`, select in tempB, target tempC (evicts B), target tempB again → selection still present (reloaded from disk).
5. `dynamic_roots.enabled: false` → `dynamic_roots_disabled` structured error.
6. Relative path → `root_not_absolute`; missing dir → `root_not_found`; a file path → `root_not_directory`.
7. All pre-existing tests pass unchanged.

## Constraints

- NEVER run mutating git commands (no add/commit/push/branch/restore). Read-only git (status/diff/log) is fine. The supervisor commits.
- NEVER touch `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` or anything outside this worktree.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*` — the supervisor owns ledgers.
- Do not add new runtime dependencies.
- Match existing code style and error-shape conventions; comments only where the code can't speak.

## Gates before you finish

Run and ensure all pass from the worktree root:

```sh
pnpm build && pnpm format:check && pnpm test
```

If `format:check` fails, run `pnpm format` and re-check.

## Final report (your last message)

- Changes made (file-by-file, brief).
- Test commands run and pass/fail counts.
- Design decisions where the spec left room (config composition for dynamic roots, LRU implementation).
- Assumptions/risks and follow-up recommendations.
