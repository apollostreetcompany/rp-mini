# Bead 19 — Industrial tree degrade ladder, ported from RP-CE, measurably better

You are the implementation engineer for bead 19 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-19-tree-ladder` in a dedicated git worktree.

## Why

rp-mini's file tree currently degrades with a blunt instrument: depth auto-trim toward a token target. RP-CE degrades adaptively — it preserves navigational truth ("where does auth/billing/tests live?") under tight budgets by keeping context-relevant subtrees deep while collapsing distant ones progressively. Product directive from the owner: rp-mini minifies surface area, NOT strength; if the tree is meaningfully worse than CE, nobody adopts the product. Target: match CE's ladder, then beat it where headless allows, with numbers.

## Hardened-code rule (mandatory)

RP-CE at `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` is battle-tested reference code — READ-ONLY, never modify, never build it. Study BEFORE implementing:

- `Sources/RepoPrompt/Features/Prompt/Services/CodeMapExtractor+Snapshots.swift:135-188` — adaptive file-tree degradation under token budgets
- `Sources/RepoPrompt/Features/Prompt/Services/PromptPackagingService.swift:436-470` — how `<file_map>` consumes tree snapshots
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPFileToolProvider.swift:171-201` — get_file_tree adaptive modes, selected view, selection/codemap markers
- `rg -n "degrade|budget|adaptive|truncat" Sources/RepoPrompt/Features/Prompt/Services/` for anything you're missing

In your final report, document CE's actual ladder (its stages, what it preserves first, how it marks elisions) and map your implementation to it stage by stage. Deviations must be argued, not silent.

## Owned paths (you may modify ONLY these)

- `packages/core/src/tree/` (implementation + tests)
- `packages/core/src/packager/index.ts` — ONLY the `<file_map>` tree-rendering call sites (do not touch file-content hydration; another bead owns it)
- `packages/core/src/packager/*.test.ts` — file_map assertions
- `packages/server/src/index.ts` — `get_file_tree` schema: add optional `max_tokens` param only
- `packages/server/src/server.test.ts` — get_file_tree scenarios
- `scripts/bench.mjs` — add a tree-quality/latency section
- `docs/bench.md` — regenerate/extend with the new section
- `README.md` — get_file_tree row + `caps.tree_tokens` row updates

## Spec

1. **Port the ladder.** Replace blunt depth-trim in `auto` mode with CE's staged degradation operating under a token budget (per-call `max_tokens`, default `config.caps.tree_tokens`). The ladder must (stages per your CE study; expected shape): full tree → collapse low-relevance deep subtrees to summarized nodes (e.g. `dir/ … (23 files, 4 dirs)`) → folders-only for distant branches → progressively shallower far from relevance anchors — while ALWAYS preserving: root structure, ancestors of relevance anchors, and the anchors themselves at full detail.
2. **Relevance anchors:** selected files/slices/codemap entries (current session selection), plus paths passed via the existing `path` arg. With no selection, anchor on repo structure heuristics per CE behavior (top-level + source dirs deeper than vendor/generated).
3. **Markers preserved and extended:** keep existing selected/codemap markers; elided nodes must say what was elided (counts), never disappear silently.
4. **Same ladder in exports:** `<file_map>` in `workspace_context op=export`/`snapshot` uses the same engine under the preset's tree budget, anchored on the selection. This is the highest-value path: handoff consumers can't search afterward.
5. **Determinism:** identical inputs (catalog snapshot + selection + budget) produce byte-identical trees (path-sorted, stable summaries) — prompt-cache stability is a product invariant.
6. **Token accounting:** rendered tree token estimate must come in at or under budget (existing estimator); report actual estimate in the response as today.
7. **Bench evidence (mandatory):** extend `scripts/bench.mjs` with a tree section run against the CE corpus at `../repoprompt-ce` (READ-ONLY corpus; caches/outputs must stay outside it, follow the existing bench pattern): for budgets 2k/5k/10k tokens report (a) render latency, (b) tokens used vs budget, (c) anchor-retention: with a 10-file selection spread across the repo, the count of selected files + their ancestor dirs visible in the rendered tree (must be 100% at every budget), (d) top-level coverage: fraction of root-level dirs still visible (target 100% at 2k). Write results into `docs/bench.md`. The old depth-trim numbers, if you can reconstruct them cheaply for comparison, are a bonus — otherwise state clearly these are new-ladder numbers.
8. **`max_tokens` schema param:** positive int, optional, capped by server at a sane ceiling (e.g. 50k) to keep responses disciplined.

## Out of scope

- File-content hydration / read_file (bead 21 owns it).
- Codemap extraction/serialization.
- Prompts/skills.
- CE repo: read-only.

## TDD (mandatory)

Failing tests first, confirm failure reason, then implement. Required scenarios (use deterministic synthetic fixtures, plus goldens):

1. Budget generosity: small repo under large budget → full tree, byte-identical to current full mode.
2. Anchor preservation: deep selected file in a large synthetic tree at a tight budget → file, its ancestors, and markers present; sibling noise collapsed to summary nodes with counts.
3. Progressive ladder: same fixture at descending budgets produces monotonically smaller trees, each within budget, each preserving anchors; no stage ever drops a root-level dir without a summary node.
4. Determinism: repeated render → identical bytes.
5. Export integration: review/plan preset export contains the budget-shaped `<file_map>` anchored on selection.
6. Golden tests for at least 2 fixture/budget combinations (follow the existing golden pattern in the repo).
7. All pre-existing tests pass; if an existing test asserts old blunt-trim output, update it deliberately and justify in the report.

## Constraints

- NEVER run mutating git commands. Read-only git is fine. The supervisor commits.
- NEVER modify `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`; bench must not write inside it.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`, CI config.
- No new dependencies.
- Determinism everywhere; no wall-clock or randomness in render logic.

## Gates before you finish

```sh
pnpm build && pnpm format:check && pnpm test
node scripts/bench.mjs ../repoprompt-ce --date 2026-06-11   # or the existing invocation pattern — inspect bench.mjs first
```

## Final report (your last message)

- CE's ladder documented (files/lines) and your stage-by-stage mapping; deviations argued.
- Changes made; test commands + red-phase proof + counts.
- Bench table (latency, tokens vs budget, anchor retention, top-level coverage at 2k/5k/10k).
- Assumptions/risks and follow-ups.
