# Bead 22 — Role profiles: explicit, visible, loud

You are the implementation engineer for bead 22 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-22-role-profiles` in a dedicated git worktree.

## Why

rp-mini already hard-gates tools via config (`tools.apply_edits=false` → tool never registered), and one-process-per-session means per-role processes are the natural boundary. What's missing is ergonomics and VISIBILITY. Owner directive: "make sure this is explicit. making it visible and usable by agents is a critical part of success over time. silent failure will be hard." A read-only explorer must KNOW it is read-only — a missing tool with no explanation reads as a bug and burns agent turns.

## Reference (read-only)

RP-CE at `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` is READ-ONLY reference. Briefly study its role/policy scoping for vocabulary and behavior: `Sources/RepoPrompt/Features/AgentMode/Runtime/ProviderBindings/AgentModeMCPPolicyInstaller.swift:3-37` and `Sources/RepoPrompt/Features/ContextBuilder/Services/DiscoverMCPToolPolicy.swift:3-32` (role-scoped tool families, TTL/lease concepts — the lease machinery does NOT apply headless; the role vocabulary does). Report what you mirrored and what you deliberately dropped.

## Owned paths (you may modify ONLY these)

- `packages/core/src/config/index.ts` + config tests (new `profile` key)
- `packages/server/src/index.ts` (profile resolution, instructions, workspace_context reporting, disabled-tool errors)
- `packages/server/src/cli.ts` (`--profile` flag for `serve`; profile-aware `tool` dispatch errors; help text)
- `packages/server/src/server.test.ts`, `packages/server/src/cli.test.ts`, `packages/server/src/dynamicRoots.test.ts` (profile × dynamic-root interplay)
- `README.md` (profiles section: table of profiles → tool surfaces, role-per-process pattern)

## Spec

1. **Profiles.** New config key `profile: "full" | "editor" | "explorer"` (default `full`), env `RP_MINI_PROFILE`, CLI `serve --profile <name>` (highest precedence). Semantics: `explorer` = read-only (disables `apply_edits`, `file_actions`; `git` stays — it is already read-only); `editor` = everything except... nothing — editor == full today, BUT keep it as a distinct named profile so hosts can pin intent and future tools (e.g. a delegation tool) can differ; `full` = everything. Profile composes with the existing `tools.*` booleans as a CLAMP: a tool is enabled only if BOTH the profile allows it AND `tools.*` is true. Explicit `tools.*=false` under a permissive profile still disables.
2. **Visibility — three surfaces, all mandatory:**
   a. **Server instructions**: the MCP server's `instructions` string (set at `new McpServer(...)`/connect — check SDK usage) must state the active profile, the enabled tool list, and the disabled tool list with one-line reason (`disabled by profile "explorer"` / `disabled by tools.apply_edits=false`).
   b. **`workspace_context` snapshot**: response gains a `server` block: `{ profile, tools_enabled: [...], tools_disabled: [{ name, reason }] }`.
   c. **Loud failures**: profile-disabled tools are STILL REGISTERED on the MCP server, but their handler returns only `{ error: { code: "tool_disabled_by_profile", profile, tool, message } }` — an agent calling them gets a typed explanation, not "unknown tool". (This is the key change from today's silent non-registration. Config-`tools.*`-disabled tools keep current non-registration behavior ONLY if profile is `full` and you can argue it; otherwise unify on register-but-refuse with `tool_disabled_by_config`. Prefer unifying — argue your choice in the report.)
   d. CLI `tool` command against a disabled tool: same structured error on stdout, non-zero exit.
3. **Dynamic roots (bead 15) interplay:** profile is PROCESS-level and clamps every context — a `root`-targeted call cannot escape `explorer` even if the target workspace's own `rp-mini.config.json` enables edit tools. Test this explicitly.
4. **Bead 18 interplay:** `apply_edits dry_run: true` is still a mutation-family call — under `explorer` it returns `tool_disabled_by_profile` (read-only means no edit machinery at all; argue if you disagree).
5. README: short "Role profiles" section — the table, the one-liner pattern ("one process per role: launch the explorer's server with `--profile explorer`"), and a note that profile is visible in instructions + workspace_context.

## Out of scope

- read_file/packager (bead 21), tree (bead 23), prompts/skills text.
- New roles beyond the three named.
- CE repo: read-only.

## TDD (mandatory)

1. `explorer`: apply_edits/file_actions calls → `tool_disabled_by_profile` typed error over linked transport; file_search/read_file/git unaffected.
2. Clamp composition: profile `full` + `tools.git=false` → git disabled with config reason; profile `explorer` + `tools.apply_edits=true` → still disabled with profile reason.
3. `workspace_context` snapshot contains the `server` block with correct enabled/disabled lists + reasons under at least 2 profiles.
4. Instructions string contains profile + disabled list (assert via server construction or transport handshake — inspect SDK surface).
5. Dynamic-root escape test: explorer + `root` targeting a workspace whose config enables tools → still refused.
6. CLI: `serve --profile explorer` wiring; `tool <ws> apply_edits ...` → structured error, non-zero exit; `--help` documents the flag.
7. env precedence: RP_MINI_PROFILE < CLI flag; config file < env (follow existing layering tests).
8. All pre-existing tests pass (some assert today's non-registration of disabled tools — update deliberately per your 2c choice and say so).

## Constraints

- NEVER run mutating git commands. Read-only git fine. Supervisor commits.
- NEVER modify `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`, CI config.
- No new dependencies. `pnpm build:prompts` must stay clean.

## Gates before you finish

```sh
pnpm build && pnpm format:check && pnpm test
```

## Final report (your last message)

- CE policy vocabulary mirrored vs dropped (files/lines); your 2c registration choice argued.
- Changes file-by-file; red-phase proof; pass/fail counts.
- Assumptions/risks and follow-ups.
