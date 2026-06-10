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
- Bead 4 implementation complete locally on `codex/feat/bead-4-codemaps`, awaiting supervisor review/commit/push. Implementation engineer intentionally did not commit or push.
- Bead 4 adds `packages/core/src/codemaps/`, checked-in codemap fixtures, `@vscode/tree-sitter-wasm`, cache-backed CodeMaps v1 for TS/TSX/JS/Python/Go/Rust, type index lookup, search symbol boost, tree `+` markers, real `get_code_structure`, and CLI codemap warm stats.
- Bead 5 implementation complete locally on `codex/feat/bead-5-selection`, awaiting supervisor review/commit/push. Implementation engineer intentionally did not commit or push.
- Bead 5 adds `packages/core/src/selection/`, selection state/profiles, full/slice/codemap modes, auto-codemap dependency selection, prompt storage, `manage_selection`, selected tree/structure, and snapshot/export basics.
- Bead 6 implementation complete locally on `codex/feat/bead-6-packager`, awaiting supervisor review/commit/push. Implementation engineer intentionally did not commit or push.
- Bead 6 adds `packages/core/src/packager/`, `shared-prompts/meta/architect.md`, `shared-prompts/meta/review.md`, config preset `mvp`, `detectIntent`, XML section assembly in configured order, receipt JSON, and `workspace_context op=export` writing paired `.md`/`.json` files under `.rp-mini/exports/`.
- Bead 9 implementation complete locally on `codex/feat/bead-9-codemap-langs`, awaiting supervisor review/commit/push. Implementation engineer intentionally did not commit or push.
- Bead 9 expands CodeMaps to Swift/Java/C/C++/C#/Ruby/PHP/Dart, adds `tree-sitter-wasms@0.1.13` for Swift/C/Dart prebuilt grammars, maps extensions (`.swift`, `.java`, `.c/.h`, `.cpp/.cc/.hpp`, `.cs`, `.rb`, `.php`, `.dart`), surfaces SwiftUI property wrappers/`View body`/preview count, and renders compact Package.swift products/dependencies/targets.

## Key context for a fresh agent
- Read AGENTS.md → CONTINUITY.md → the design doc, in that order.
- Reference implementation: ../repoprompt-ce (Apache 2.0). Reuse its codemap golden fixtures for parity tests.
- Implementation agents: Codex (GPT-5.5-fast); primary agent reviews, runs tests, commits, pushes.
- Local Bead 2 validation passed: `pnpm build && pnpm format:check && pnpm test` (6 files, 22 tests) and `node packages/server/dist/cli.js index .` (`40 files, 14 dirs, 9 ignored`; snapshot excludes `node_modules` and `.rp-mini`).
- Local Bead 3 validation passed: `pnpm build && pnpm format:check && pnpm test` (9 files, 33 tests). Linked-transport acceptance smoke passed: `file_search {"pattern":"estimateTokens"}` returned `limit_hit=false`; `read_file` with `start_line=-5` returned 5 lines; `get_file_tree mode=auto` estimated 530 tokens.
- Local Bead 4 validation passed: `pnpm build && pnpm format:check && pnpm test` (10 files, 48 tests). Acceptance smokes: `node packages/server/dist/cli.js index .` cold run computed 28 codemaps and skipped 26 gated files; second run cached 28. Linked-transport `get_code_structure` for `packages/core/src/catalog/index.ts` returned `getCatalog`, `buildCatalog`, and `verifyFresh` with line numbers.
- Local Bead 5 validation passed: `pnpm build && pnpm format:check && pnpm test` (56 tests). Linked-transport acceptance covered selection summary, prompt ops, stable snapshot hash, export path, selected tree/code, and stale slice invalidation.
- Local Bead 6 validation passed: `pnpm build && pnpm format:check && pnpm test` (63 tests). Linked-transport acceptance covered `workspace_context op=export preset=plan` writing payload and receipt paths, same-state stable content hash, different export paths, and receipt files with technical fields.
- Local Bead 9 validation passed: `pnpm build && pnpm format:check && pnpm test` (107 tests). Acceptance smokes: `node packages/server/dist/cli.js index .` on a temp 8-language fixture tree computed 8 codemaps; linked-transport `get_code_structure Sources/App/CounterView.swift` returned `@State`, `@Binding`, `@Environment`, `@StateObject`, `@ObservedObject`, `@Published`, `View body`, and `Previews: 2`.
- `handoff/beads.jsonl` was not appended by the implementation engineer because no commit SHA exists yet; supervisor should append final bead evidence after review and commit.
