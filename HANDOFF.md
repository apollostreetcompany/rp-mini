# HANDOFF.md - rp-mini

Pre-compaction context handoff. Updated before context compaction and at major milestones.

## Current state (2026-06-10)
- Design complete and user-approved: docs/plans/rp-mini-design-2026-06-10.md (v4, build-approved).
- Repo bootstrapped with workflow contract files; GitHub remote: apollostreetcompany/rp-mini (private).
- Bead 1 merged to main via PR #1 (squash 50e0f4f, CI green).
- Bead 2 implementation complete locally on `codex/feat/bead-2-catalog`, awaiting supervisor review/commit/push. Implementation agent intentionally did not commit or push.
- Bead 2 adds catalog/cache/index substrate: `packages/core/src/catalog/`, `packages/core/src/cache/`, config `ignore.extra` and `ignore.ios_preset`, `@rp-mini/core` cache/catalog exports, and `rp-mini index` snapshot writing to `.rp-mini/catalog.json`.
- Bead 3 implementation complete locally on `codex/feat/bead-3-nav`, awaiting supervisor review/commit/push. Implementation engineer intentionally did not commit or push.
- Bead 3 adds `packages/core/src/search/`, `packages/core/src/read/`, `packages/core/src/tree/`, optional `@vscode/ripgrep` dependency, `Config.search.ripgrep_path`, and real server handlers for `file_search`, `read_file`, and `get_file_tree`.

## Key context for a fresh agent
- Read AGENTS.md → CONTINUITY.md → the design doc, in that order.
- Reference implementation: ../repoprompt-ce (Apache 2.0). Reuse its codemap golden fixtures for parity tests.
- Implementation agents: Codex (GPT-5.5-fast); primary agent reviews, runs tests, commits, pushes.
- Local Bead 2 validation passed: `pnpm build && pnpm format:check && pnpm test` (6 files, 22 tests) and `node packages/server/dist/cli.js index .` (`40 files, 14 dirs, 9 ignored`; snapshot excludes `node_modules` and `.rp-mini`).
- Local Bead 3 validation passed: `pnpm build && pnpm format:check && pnpm test` (9 files, 33 tests). Linked-transport acceptance smoke passed: `file_search {"pattern":"estimateTokens"}` returned `limit_hit=false`; `read_file` with `start_line=-5` returned 5 lines; `get_file_tree mode=auto` estimated 530 tokens.
- `handoff/beads.jsonl` was not appended by the implementation engineer because no commit SHA exists yet; supervisor should append final bead evidence after review and commit.
