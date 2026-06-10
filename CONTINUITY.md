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

## State

### Done
- [x] Repo scaffolded with contract files; GitHub remote created
- [x] Bead 1 implementation complete locally: monorepo scaffold, config loader, token heuristic, MCP server stubs, CLI, CI, Apache-2.0 license, third-party notice. Awaiting supervisor review/commit.

### Now
- Supervisor review of Bead 1 working tree; no commit/push performed by implementation agent per prompt.

### Next
- Bead 2: catalog (walk/ignore/caps/lazy grammars) + `rp-mini index` warm command
- Bead 3: search/read/tree + relevance ranker

## Open Questions
- UNCONFIRMED: final published name ("rp-mini" working title; RepoPrompt trademark courtesy check before any public release)
- Slice anchor-rebase deferred (v1 invalidates slices on content change)

## Working Set
- docs/plans/rp-mini-design-2026-06-10.md — canonical design
- ../repoprompt-ce — reference source (golden fixtures at Tests/RepoPromptTests/CodeMap/Goldens/)
- handoff/beads.jsonl — bead evidence
- package.json / pnpm-workspace.yaml / tsconfig*.json — Bead 1 monorepo and build/test entrypoints
- packages/core/src/config/index.ts — layered config defaults and loader
- packages/core/src/tokens/index.ts — heuristic token estimator
- packages/server/src/index.ts / packages/server/src/cli.ts — MCP stub server and `rp-mini` CLI
