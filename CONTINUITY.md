# CONTINUITY.md - rp-mini

## Goal (incl. success criteria)
Build rp-mini per docs/plans/rp-mini-design-2026-06-10.md: a TypeScript MCP context engine (10 tools) + CC/Codex plugins capturing RepoPrompt's context-building magic, faster and contention-free. Success: beads 1-12 complete, CI green, bench beats CE on index/search/context-build wall clock, 4+ concurrent agent sessions with no blocking.

## Constraints/Assumptions
- Design doc is canonical; deviations require a logged decision.
- Implementation by Codex agents (GPT-5.5-fast), supervised/reviewed/committed by primary agent.
- Big source files ALWAYS get codemaps (user decision); only generated/minified content is gated; codemap output capped per file.
- Keep-alive daemon must be OOM-safe (bounded LRU caches, RSS watchdog, graceful restart) — runs on long-lived headless machines.
- Codex has native subagents; headless builder CLI deferred post-MVP.

## Key Decisions
1. (2026-06-10) Form factor: MCP server core + CC plugin + Codex plugin. TypeScript/Node. apply_edits ladder in. Full nav suite in.
2. (2026-06-10) Context building delivered as host subagents (CC agent def + Codex subagent config) from one shared prompt module.
3. (2026-06-10) Per-session stdio processes; shared sha256+mtime codemap disk cache with atomic writes; verify-on-read freshness; no ingress barriers.
4. (2026-06-10) Perf round: token delta-accounting, type→file index, post-ripgrep ranking, content-hashed snapshots, lazy grammars + OOM-safe keep-alive daemon.
5. (2026-06-10) Receipts aligned with operator-contracts-and-receipts; mvp preset; proconsult consumes rp-export files.
6. (2026-06-10) iOS: Tier 1.5 (ignore preset, Package.swift deps, metadata annotations) post-MVP; SwiftUI codemap v2 + asset summarizer Tier 2. Orthogonal to Xcode/Figma MCP.
7. (2026-06-10) Bead 1 implementation uses pnpm workspaces, TypeScript strict ESM, SDK `McpServer.registerTool` with Zod-backed schemas, and SDK validation semantics where invalid tool calls return `isError: true` MCP results instead of throwing client-side.
8. (2026-06-10) Bead 2 entry: implement catalog/cache/index test-first on branch `codex/feat/bead-2-catalog`; do not commit or push from the implementation-agent turn. Lazy grammar loading remains with codemap work in Bead 4; Bead 2 owns only catalog/cache substrate.
9. (2026-06-10) Bead 2 implementation keeps `.xcodeproj` packages fully ignored under the iOS preset, while `.xcassets` directories are retained as single summarizable directory nodes without descending into internals.
10. (2026-06-10) Bead 3 entry: implement navigation tools on branch `codex/feat/bead-3-nav`; scope is real `file_search`, `read_file`, and `get_file_tree` only, no commit/push by implementation engineer. Risk class: Medium because MCP tool schemas/behavior change; rigor: TDD with temp-dir fixtures and linked-transport server smoke.
11. (2026-06-10) Bead 4 implementation uses `@vscode/tree-sitter-wasm` parser APIs for lazy WASM grammars because `tree-sitter-wasms` installed but its binaries failed a `web-tree-sitter` 0.26 load probe. Final runtime dependency is `@vscode/tree-sitter-wasm`; `tree-sitter-wasms` was removed as unused.
12. (2026-06-10) Bead 4 serializer targets CE structural parity, not byte parity: same section ordering and line-numbered signatures, with member-list truncation markers preserving later sections such as exports.
13. (2026-06-10) Bead 6 entry: implement packager XML payloads, intent presets, meta prompts, and export receipts on branch `codex/feat/bead-6-packager`; do not commit/push by implementation engineer. Risk class: Medium because `workspace_context` export/snapshot behavior and MCP input schema change; rigor: TDD with core packager fixtures plus linked-transport export smoke.
14. (2026-06-10) Bead 7 implementation ports the apply_edits ladder as a fail-closed TypeScript engine: literal, escape-decode, normalized line fuzzy matching with ambiguity rejection, transactional batch spans, CRLF/trailing-newline preservation, and post-mutation catalog/codemap/selection refresh hooks.

## State

### Done
- [x] Repo scaffolded with contract files; GitHub remote created
- [x] Bead 1 MERGED to main (PR #1, squash 50e0f4f, CI green): monorepo scaffold, layered config, token heuristic, 10-tool MCP server skeleton, CLI, CI, LICENSE/notices. 10/10 tests. Branch protection: `test` check required on main.
- [x] Bead 2 implementation complete locally for supervisor review: catalog walk/ignore stack/iOS preset, size/binary/generated flags, verifyFresh, cache substrate, and `rp-mini index` snapshot. Validation: `pnpm build && pnpm format:check && pnpm test` passed (22 tests); `node packages/server/dist/cli.js index .` wrote `.rp-mini/catalog.json` with 40 files, 14 dirs, 9 ignored; no commit/push by implementation agent.
- [x] Bead 3 implementation complete locally for supervisor review: real `file_search`, `read_file`, and `get_file_tree` handlers wired through MCP linked transport; core search/read/tree modules added with TDD coverage. Validation: `pnpm build && pnpm format:check && pnpm test` passed (33 tests). Acceptance smoke over linked transport passed: `file_search {"pattern":"estimateTokens"}` returned `limit_hit=false`, `read_file start_line=-5` returned 5 lines, and `get_file_tree mode=auto` estimated 530 tokens. No commit/push by implementation engineer.
- [x] Bead 4 implementation complete locally for supervisor review: CodeMaps v1 for TS/TSX/JS/Python/Go/Rust via lazy WASM parser, FileAPI serializer, sha cache, type index, search symbol boost, `get_code_structure`, tree `+` markers, and `rp-mini index` codemap warm stats. Validation: `pnpm build && pnpm format:check && pnpm test` passed (48 tests). Acceptance: cold index computed 28 codemaps then second index cached 28; linked transport `get_code_structure packages/core/src/catalog/index.ts` listed `getCatalog`, `buildCatalog`, and `verifyFresh` with line numbers. No commit/push by implementation engineer.
- [x] Bead 5 implementation complete locally for supervisor review: selection state machine, slice normalization/subtraction, per-session persistence, profiles, auto-codemap dependencies, token delta accounting, prompt storage, `manage_selection`, `workspace_context`, selected tree, and selected code structure. Validation: `pnpm build && pnpm format:check && pnpm test` passed (56 tests). Acceptance covered over linked transport: full selection summary with token totals, auto codemap for referenced type definitions, stable workspace snapshot hash, export path with injected clock, prompt ops, and stale slice invalidation. No commit/push by implementation engineer.
- [x] Bead 6 implementation complete locally for supervisor review: packager XML payload assembly, presets including `mvp`, review intent detection, shared Architect/Review meta prompts, receipt JSON, and `workspace_context` export payload+receipt wiring. Validation: `pnpm build && pnpm format:check && pnpm test` passed (63 tests). Acceptance covered over linked transport: two selected files + prompt exported with plan preset, payload contained `<file_map>`, `<file_contents>`, `<meta prompt 1 = "Architect">`, and `<user_instructions>`; repeated export produced the same content hash and different payload paths. No commit/push by implementation engineer.
- [x] Bead 7 implementation complete locally for supervisor review: real `apply_edits` ladder, transactional batch edits, `file_actions`, workspace path guardrails, unified diff output, codemap cache eviction, catalog memo invalidation, and selection token/slice refresh. Validation: `pnpm build && pnpm format:check && pnpm test` passed (82 tests). Acceptance covered over linked transport: whitespace-drifted search succeeded with `matched_by:["fuzzy"]`; ambiguous two-block fuzzy edit returned `ambiguous_match` with candidate lines and left the file untouched; 3-edit batch produced the hand-computed final file. No commit/push by implementation engineer.
- [x] Bead 8 implementation complete locally for supervisor review: read-only `gitx` core module, real MCP `git` status/diff/log/show/blame dispatch, safe git flags, compare specs, structured hunks, patch truncation, binary flags, and automatic review-preset `<git_diff>` export integration. Validation: `pnpm build && pnpm format:check && pnpm test` passed (93 tests). Acceptance covered over linked transport: status reflected staged/unstaged/untracked mix; diff patches returned hunk `oldStart`/`newStart`; review export payload contained actual `<git_diff>` and counted `tokens.git_diff`. No commit/push by implementation engineer.

### Now
- Bead 8 complete locally on `codex/feat/bead-8-git`; awaiting supervisor review/commit/push. `handoff/beads.jsonl` still needs supervisor append after review/commit because schema requires `commit_sha`.

### Next
- Bead 9: codemap language expansion (swift/java/c/cpp/csharp/ruby/php/dart).

## Open Questions
- UNCONFIRMED: final published name ("rp-mini" working title; RepoPrompt trademark courtesy check before any public release)
- Slice anchor-rebase deferred (v1 invalidates slices on content change)

## Working Set
- docs/plans/rp-mini-design-2026-06-10.md — canonical design
- ../repoprompt-ce — reference source (golden fixtures at Tests/RepoPromptTests/CodeMap/Goldens/)
- handoff/beads.jsonl — bead evidence
- package.json / pnpm-workspace.yaml / tsconfig*.json — Bead 1 monorepo and build/test entrypoints
- packages/core/src/config/index.ts — layered config defaults and loader
- packages/core/src/catalog/ — Bead 2 catalog walk, ignore stack, generated detection, verify-on-read
- packages/core/src/cache/ — Bead 2 .rp-mini cache helpers and atomic JSON writes
- packages/core/src/tokens/index.ts — heuristic token estimator
- packages/core/src/search/ — Bead 3 ripgrep bridge, path fuzzy search, caps, ranker
- packages/core/src/read/ — Bead 3 read-file slicing with verify-on-read and refusal errors
- packages/core/src/tree/ — Bead 3 deterministic tree rendering and auto trim
- packages/core/src/codemaps/ — Bead 4 lazy WASM codemap extraction, serializer, cache, and type index
- packages/core/src/packager/ — Bead 6 packager XML assembly, intent presets, receipts
- packages/core/src/edits/ — Bead 7 apply_edits ladder, batch edit transactionality, and file_actions helpers
- shared-prompts/meta/ — Bead 6 shared meta prompt markdown
- packages/server/src/index.ts / packages/server/src/cli.ts — MCP server handlers and `rp-mini` CLI
- packages/server/src/cli.test.ts — Bead 2 CLI index smoke over temp roots
