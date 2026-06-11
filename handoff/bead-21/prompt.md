# Bead 21 — Batched reads + resolve-all-then-hydrate-concurrently pipeline

You are the implementation engineer for bead 21 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-21-hydration` in a dedicated git worktree.

## Why

An agent reading 8 files today pays 8 MCP round-trips, and the packager hydrates selected file contents one at a time during export. RP-CE treats context assembly as a pipeline: resolve all requested paths first (collecting invalid ones), then hydrate contents concurrently under caps. For monorepo tasks touching route+controller+model+schema+tests at once, this is the difference between snappy and sluggish. Product directive: minify surface area, not strength.

## Hardened-code rule (mandatory)

RP-CE at `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` is battle-tested reference — READ-ONLY, never modify, never build. Study BEFORE implementing:

- `Sources/RepoPrompt/Features/Prompt/Services/PromptContextPreAssemblyService.swift:8-25, 82-145` — resolve-then-hydrate pre-assembly
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/WorkspaceSelectionMutationService.swift:43-140` — batch path resolution incl. invalid-path collection
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPFileToolProvider.swift:265-369` — read_file semantics (range/tail reads)

Report CE's mechanism and your mapping; argue deviations explicitly.

## Owned paths (you may modify ONLY these)

- `packages/core/src/read/` (implementation + tests)
- `packages/core/src/packager/index.ts` — file-content hydration only (the `<file_contents>` build path; do NOT touch the tree/file_map logic that bead 19 just landed)
- `packages/core/src/packager/*.test.ts`
- `packages/core/src/config/index.ts` — only if adding `concurrency.hydrate` (see spec)
- `packages/server/src/index.ts` — `read_file` schema/handler only
- `packages/server/src/server.test.ts`
- `README.md` — read_file row + any new config row

## Spec

1. **Batched `read_file`.** Schema gains optional `paths: string[]` (1–32 entries), mutually exclusive with `path` (validation error if both or neither). Single-`path` behavior is byte-identical to today (back-compat: response shape unchanged for `path`). With `paths`: resolve ALL paths against the catalog first; response is `{ files: [...], invalid_paths: [...] }` where each entry carries the same fields as a single read result plus its `path`. `start_line`/`limit` apply to every path in the batch (CE-consistent; document it). Hydrate the batch concurrently with bounded concurrency.
2. **Response discipline:** batched responses respect a total character budget (reuse the existing read cap approach — inspect how single reads cap content; apply a fair-share split: per-file cap = budget / batch size, with `limit_hit` + `omitted`/suggestion semantics consistent with file_search shaping). An over-budget batch must degrade per-file, never crash or return unbounded output.
3. **Concurrent packager hydration.** In `packages/core/src/packager/index.ts`, the selected-file content hydration must: (a) resolve all selection entries first (full files and slices), surfacing invalid/stale entries the way the current sequential code does — semantics unchanged; (b) hydrate contents with bounded concurrency (`concurrency.hydrate`, default 8, env `RP_MINI_CONCURRENCY_HYDRATE`, added to config + README); (c) preserve EXACT output ordering and bytes — the rendered payload must be byte-identical to the sequential version for the same inputs (path-sorted sections are a prompt-cache invariant; only wall-clock may change).
4. **`root` param (bead 15) and verify-on-read freshness must keep working** for both single and batched reads.

## Out of scope

- Tree/file_map rendering (bead 19 landed it; bead 23 is refining it separately — do not touch `packages/core/src/tree/`).
- Search, edits, prompts/skills.
- CE repo: read-only.

## TDD (mandatory, in this order)

1. Batched read: 3 valid + 1 invalid path → `files` in request order with correct contents/ranges, `invalid_paths` lists the bad one; single-`path` calls unchanged (assert exact current shape).
2. Mutual-exclusion validation errors (`path`+`paths`, neither).
3. Budget: batch of large files → per-file fair-share caps, `limit_hit` semantics, bounded response size.
4. Packager determinism: export with ≥10 selected files → payload byte-identical to the pre-change implementation (capture expected output from current main BEFORE implementing — that is your golden).
5. Packager concurrency: instrument with an injected readFile spy — at least 2 reads in flight simultaneously on a 10-file selection (the packager already supports an injected `readFile` option; use it).
6. Batched read via MCP linked transport incl. a `root`-targeted batch.
7. All pre-existing tests pass unchanged.

## Constraints

- NEVER run mutating git commands. Read-only git fine. Supervisor commits.
- NEVER modify `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`, CI config.
- No new dependencies.
- `pnpm build:prompts` must stay clean (CI drift guard).

## Gates before you finish

```sh
pnpm build && pnpm format:check && pnpm test
```

## Final report (your last message)

- CE mechanism studied (files/lines), mapping, argued deviations.
- Changes file-by-file; red-phase proof; pass/fail counts.
- Measured speedup of packager hydration on a multi-file export (rough numbers fine).
- Assumptions/risks and follow-ups.
