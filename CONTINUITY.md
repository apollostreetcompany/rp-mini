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

## State

### Done
- [x] Repo scaffolded with contract files; GitHub remote created
- [x] Bead 1 MERGED to main (PR #1, squash 50e0f4f, CI green): monorepo scaffold, layered config, token heuristic, 10-tool MCP server skeleton, CLI, CI, LICENSE/notices. 10/10 tests. Branch protection: `test` check required on main.
- [x] Bead 2 implementation complete locally for supervisor review: catalog walk/ignore stack/iOS preset, size/binary/generated flags, verifyFresh, cache substrate, and `rp-mini index` snapshot. Validation: `pnpm build && pnpm format:check && pnpm test` passed (22 tests); `node packages/server/dist/cli.js index .` wrote `.rp-mini/catalog.json` with 40 files, 14 dirs, 9 ignored; no commit/push by implementation agent.
- [x] Bead 3 implementation complete locally for supervisor review: real `file_search`, `read_file`, and `get_file_tree` handlers wired through MCP linked transport; core search/read/tree modules added with TDD coverage. Validation: `pnpm build && pnpm format:check && pnpm test` passed (33 tests). Acceptance smoke over linked transport passed: `file_search {"pattern":"estimateTokens"}` returned `limit_hit=false`, `read_file start_line=-5` returned 5 lines, and `get_file_tree mode=auto` estimated 530 tokens. No commit/push by implementation engineer.

### Now
- Supervisor review of Bead 3 working tree on `codex/feat/bead-3-nav`; no commit/push performed by implementation engineer per prompt. `handoff/beads.jsonl` still needs supervisor append after review/commit because schema requires `commit_sha`.

### Next
- Bead 4: codemaps v1 + cache + type index + lazy grammars

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
- packages/server/src/index.ts / packages/server/src/cli.ts — MCP stub server and `rp-mini` CLI
- packages/server/src/cli.test.ts — Bead 2 CLI index smoke over temp roots
