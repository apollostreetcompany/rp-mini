# Bead 16 — Handoff durability, export receipts, and investigation triage in contract + skills

You are the implementation engineer for bead 16 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-16-handoff-receipts` in a dedicated git worktree.

## Why

A 3-agent benchmark surfaced three workflow gaps. (1) A context-builder running as a separate process can curate a selection the host never sees — the handoff must survive process boundaries via named selection profiles. (2) rp-mini scored 2/5 on "reproducible context artifact" because the skills never mandate an export receipt. (3) The full rp-investigate ritual lost to plain shell on a bounded question — the skill needs a triage fast path. Additionally, skills must teach the workspace-binding check and the new per-call `root` parameter (landing in parallel as bead 15) plus the shell CLI fallback.

## Owned paths (you may modify ONLY these)

- `shared-prompts/discovery/contract.md`
- `packages/cc-plugin/scripts/build-prompts.mjs` (only if generation needs it)
- `packages/cc-plugin/agents/context-builder.md` — GENERATED: regenerate via `pnpm build:prompts`, never hand-edit
- `packages/cc-plugin/skills/*/SKILL.md`
- `packages/codex-plugin/skills/*/SKILL.md` (including `skills/context-builder/SKILL.md`, also generated — check how `pnpm build:prompts` produces it)
- cc-plugin and codex-plugin test files (`packages/cc-plugin/**/*.test.ts`, `packages/codex-plugin/src/plugin.test.ts`)

## Spec

1. **Selection-profile handoff (contract.md).** In the "Mandatory Pre-Halt Checklist", add a required step: save the final selection as a named profile via `manage_selection` (use the exact op/parameter names from the real tool schema in `packages/server/src/index.ts` — verify, do not guess) with name `handoff-<short-task-slug>`, and state the profile name plus the final token total in your final message so the host (possibly a different rp-mini process) can reload the exact selection. Mention reload (`op=load`) in the same step.
2. **Workspace binding (contract.md).** Add a short "Workspace Binding" subsection near "Available Tools": as your FIRST tool action, verify the server is bound to the target workspace (e.g. `get_file_tree mode=folders max_depth=1`); if the target is a different checkout, pass `root="<absolute path>"` on every rp-mini tool call. Do NOT add shell/CLI instructions to the contract — the builder remains non-mutating with no shell access, and `apply_edits`/`file_actions` must stay out of its allowlist.
3. **Triage fast path (rp-investigate, both plugins).** Bounded question (single subsystem, named symbol, roughly ≤5 files) → answer inline with direct tools (`file_search`, `read_file`, `get_code_structure`); do not spawn the context-builder. Broad, cross-cutting, or durable-context-pack requests → full builder flow. Both paths keep line-cited evidence.
4. **Workspace binding & fallback note (ALL rp-* skills, both plugins).** 2–4 lines: check binding first; on mismatch pass `root=<absolute path>` per call; where a shell is available and no MCP client is loaded, the shell CLI works against any path (`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '…'` or its wrappers).
5. **Export receipts (rp-investigate, rp-review, rp-export skills, both plugins).** Mandate: finish by producing a `workspace_context` export receipt (token totals + content hash) and cite it — plus the saved handoff profile name — in the final report; when the caller asked for a durable artifact, write the export to a file (host Write tool or shell CLI).
6. **Tests (TDD).** Extend the existing plugin/prompt-sync tests to assert: contract contains the profile-save mandate and the workspace-binding/root text; generated cc agent and codex context-builder skill stay in sync (existing mechanism); every rp-* skill contains the binding note; rp-investigate contains the triage fast-path; receipts mandate present in investigate/review/export. The codex skill line-count limit (currently ≤70 lines in `plugin.test.ts`) may be raised to ≤90 if genuinely needed — change it deliberately in the same commit with the new assertions, and say so in your report.

## Out of scope

- Server/core source code (beads 15 and 17 own those). You may READ `packages/server/src/index.ts` to get exact op names.
- README, `.mcp.json`, `mcp-servers.toml`, `install.sh`.
- Do not reintroduce write tools into the builder allowlist anywhere (contract, agent frontmatter, generator, tests).

## TDD (mandatory)

Write/extend failing test assertions first, confirm they fail for the right reason, then edit prompts/skills and regenerate (`pnpm build:prompts`) until green.

## Constraints

- NEVER run mutating git commands (no add/commit/push/branch/restore). Read-only git is fine. The supervisor commits.
- NEVER touch `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` or anything outside this worktree.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`.
- Keep skill prose tight and imperative, matching the existing voice; no new dependencies.

## Gates before you finish

```sh
pnpm build && pnpm build:prompts && pnpm format:check && pnpm test
```

Run `git status --short` at the end and confirm the generated files are consistent (no half-regenerated state). If `format:check` fails, run `pnpm format` and re-check.

## Final report (your last message)

- Changes made (file-by-file, brief).
- Test commands run and pass/fail counts.
- Exact op/parameter names you verified for selection profiles and `workspace_context` export.
- Whether the line-count test limit changed and why.
- Assumptions/risks and follow-up recommendations.
