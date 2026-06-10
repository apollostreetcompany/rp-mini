# AGENTS.md - rp-mini

## 1. Mission (North Star)
A minimal, configurable context-engineering plugin for coding agents — RepoPrompt's best ideas without the app.
1. Token-efficient context infrastructure: codemaps, curated selection (full/slices/codemap), packaged prompts, capped nav tools.
2. Fast and contention-free under multiple concurrent agents (per-session processes, shared atomic caches, optional OOM-safe daemon).
3. Ship as: host-agnostic MCP server (TypeScript) + Claude Code plugin (skills + context-builder subagent) + Codex plugin (subagent + skills).

Canonical design: `docs/plans/rp-mini-design-2026-06-10.md`. Reference implementation analyzed: repoprompt-ce (Apache 2.0).

## 2. Core Architecture
pnpm monorepo:
```
packages/core      # catalog, codemaps (tree-sitter), tokens, selection, search (ripgrep), edits, packager, gitx, config
packages/server    # MCP stdio server: 10 tools (file_search, read_file, get_file_tree, get_code_structure,
                   #   manage_selection, workspace_context, prompt, apply_edits, file_actions, git)
packages/cc-plugin # Claude Code plugin: agents/context-builder, skills/rp-*
packages/codex-plugin # Codex packaging: subagent config, skills, config.toml snippet
shared-prompts/    # single-source discovery + workflow prompts
```
Intelligence runs on the host harness; rp-mini is the stateful context engine.

## 3. Tech Stack
| Layer | Choice | Specifics |
| --- | --- | --- |
| Language | TypeScript (strict) | Node >= 22 |
| Package mgr | pnpm workspaces | |
| MCP | @modelcontextprotocol/sdk | stdio transport |
| Parsing | tree-sitter (native) + web-tree-sitter (WASM fallback) | 14 languages, phased |
| Search | ripgrep subprocess (--json) | + post-rank: proximity/recency/symbol |
| Tests | vitest | golden-file tests for codemaps + packager |
| CI | GitHub Actions | tsc + vitest required for merge |

## 4. Agent and Sub-Agent Profiles
Hybrid Agent Selection Policy (per global ~/.codex/AGENTS.md) applies. Implementation agents: Codex (codex@codex-local, GPT-5.5-fast) for bead implementation; primary (Claude) supervises, reviews, commits. Hard guardrails: public tool-schema changes and release/packaging beads require primary-agent review before merge.

## 5. Branching & Commits
Convention: `<type>(bead-N): description` — feat, optimization, fix, test, docs, chore. Branches: `codex/<type>/bead-N-description`. No direct commits to `main` after initial scaffold; squash merge only; delete merged branches.

## 6. Continuity Ledger
`CONTINUITY.md` read/updated every turn; Ledger Snapshot in implementation/review replies; UNCONFIRMED markers for gaps. Bead evidence appended to `handoff/beads.jsonl` (schema in `handoff/beads.schema.json`).

## 7. Workflow
Bead Entry Gate: scope + acceptance tests explicit, falsifiable done predicate, agent selected, tools declared, risk class (Low/Medium/High) and rigor declared. Bead Exit Gate: tests pass for risk class, reviewer checklist done, CONTINUITY.md + beads.jsonl updated, bead summary posted, commit + push. TDD default: tests written first, confirmed failing for the right reason, then minimal implementation.

Bead plan (from design doc §6): 1 scaffold/config/server-skeleton/CI · 2 catalog+ignore+warm · 3 search/read/tree+ranker · 4 codemaps v1+cache+type-index · 5 tokens+selection+profiles · 6 packager+presets+receipts · 7 apply_edits ladder · 8 git tool · 9 codemaps v2 langs · 10 cc-plugin · 11 codex-plugin · 12 bench+multi-agent stress.

## 8. Orchestration
Spawn contract: every spawned agent prompt includes owned paths, in/out of scope, required tools, acceptance tests, and report format (changes, test commands/results, assumptions/risks, follow-ups). Codex implementation agents work in the repo on a bead branch; primary agent reviews diff, runs tests, commits, pushes. Escalation to primary review required for: tool schema changes, edit-engine matching logic, release/signing/packaging.
