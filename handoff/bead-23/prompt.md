# Bead 23 — Tree ladder budget-fill: use the budget CE leaves on the table

You are the implementation engineer for bead 23 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/optimization/bead-23-tree-budget-fill` in a dedicated git worktree. Bead 19 (already merged, study its code in `packages/core/src/tree/index.ts`) ported CE's staged auto-tree ladder faithfully.

## Why

The bead-19 bench exposed a CE trait we kept faithfully: the ladder is coarse-grained. On the CE corpus, budgets of 5,000 AND 10,000 tokens both select the same 2,939-token stage — over 70% of a 10k budget unused while navigational detail was available. Owner directive: where headless lets us, be measurably BETTER than CE, not just equal. This bead refines WITHIN the winning stage family to fill the budget, deterministically.

## Owned paths (you may modify ONLY these)

- `packages/core/src/tree/index.ts` and `packages/core/src/tree/tree.test.ts` (incl. goldens — regenerate deliberately)
- `packages/core/src/packager/packager.test.ts` ONLY if file_map assertions need updating for refined output
- `scripts/bench.mjs` — extend the existing tree section minimally if needed (budget-utilization column)
- `docs/bench.md` — refresh the tree section numbers

## Spec

1. **Budget-fill refinement.** After the existing ladder picks the first stage that fits (keep stage ORDER and semantics from bead 19 exactly), refine within that stage's parameter family to the LARGEST variant that still fits the budget:
   - For depth-capped stages (`full depth N`, `folders depth N`): search depth upward (N+1, N+2, … up to max catalog depth), render+estimate each, keep the deepest fitting. Use exponential+binary search if linear is slow; with renders at ~25ms and depth ≤ ~15, linear is acceptable — measure and choose.
   - For collapse-distant stages (`collapseDistantAt: K`): search K upward the same way.
   - The unbounded stages (`full` unlimited; final fallbacks) have no parameter — unchanged.
2. **Invariants (all preserved from bead 19):** anchors + ancestors always present; counted summary nodes, never silent elision; byte-deterministic output for identical inputs; result token estimate ≤ budget; `limit_hit`/`suggestion` semantics (update suggestion text to name the refined parameters, e.g. `full tree, distant subtrees summarized at depth 6`).
3. **Monotonicity:** larger budget must never produce a tree with FEWER visible nodes than a smaller budget on identical input (add a property-style test across 3+ budgets on a synthetic fixture).
4. **Perf discipline:** auto render on the CE corpus must stay under 150ms median at 10k budget (bead-19 baseline ~23-31ms; refinement multiplies renders — keep it bounded; cache the built node tree across candidate renders rather than rebuilding from the catalog each time if needed).
5. **Bench evidence (mandatory):** rerun the tree bench section on the CE corpus (`node scripts/bench.mjs <ce-path> --date 2026-06-11`; the CE checkout is at `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`, READ-ONLY — outputs/caches must stay outside it; follow the existing bench pattern). Required result: tokens-used at 5k budget > 2,939 and at 10k > 5,000 (i.e. ≥50% utilization) with anchor retention and top-level coverage still 100%; report the new utilization column. If utilization targets prove impossible while preserving invariants, STOP and report why rather than weakening invariants.

## Out of scope

- Stage order/semantics changes, new stages, non-auto modes.
- Server schema (max_tokens exists), packager hydration (bead 21 owns), profiles (bead 22 owns).
- CE repo: read-only.

## TDD (mandatory)

1. RED first: a test asserting ≥50% budget utilization on a synthetic deep fixture at a budget that today lands on a coarse under-filled stage — confirm it fails against bead-19 behavior.
2. Refinement correctness: deepest-fitting parameter chosen (construct a fixture where depth 4 fits but depth 5 doesn't — assert depth-4 output exactly).
3. Monotonicity property test (spec 3).
4. Determinism: repeated renders byte-identical.
5. Anchor preservation at refined depths (reuse bead-19 fixtures).
6. Golden regeneration: update bead-19 goldens that legitimately change; in the report, show a before/after for ONE golden demonstrating strictly more detail within budget.
7. All pre-existing tests pass (packager file_map assertions updated only if needed).

## Constraints

- NEVER run mutating git commands. Read-only git fine. Supervisor commits.
- NEVER modify `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`; bench must not write inside it.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`, CI config.
- No new dependencies. No wall-clock/randomness in render logic.

## Gates before you finish

```sh
pnpm build && pnpm format:check && pnpm test
node scripts/bench.mjs /Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce --date 2026-06-11
```

## Final report (your last message)

- Refinement algorithm chosen (linear vs binary, caching) with measured render cost.
- Changes file-by-file; red-phase proof; pass/fail counts.
- Bench table incl. budget-utilization before/after at 2k/5k/10k; one golden before/after excerpt.
- Assumptions/risks and follow-ups.
