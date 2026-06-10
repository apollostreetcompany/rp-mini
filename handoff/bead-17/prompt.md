# Bead 17 — Stream ripgrep output in the search engine

You are the implementation engineer for bead 17 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/fix/bead-17-stream-rg-search` in a dedicated git worktree.

## Why

Bead-12 benchmarking found that broad content queries (e.g. pattern `import` across a large corpus) make ripgrep emit more `--json` stdout than the Node `execFile` `maxBuffer` allows, throwing "stdout maxBuffer length exceeded" BEFORE rp-mini's own response shaping ever runs. The search engine must consume rg incrementally and stop early, so no query can crash it.

## Owned paths (you may modify ONLY these)

- `packages/core/src/search/index.ts`
- the search test file(s) under `packages/core/src/search/` (find the existing one and extend it; add a new test file if cleaner)

## Spec

Target: `contentSearch` in `packages/core/src/search/index.ts` (~lines 195–260), which currently does `execFileAsync(rg, args, { cwd, maxBuffer: max(config.caps.search_chars * 4, 1MB) })` and then parses `stdout.split(/\r?\n/)`.

1. Replace the buffered exec with `spawn` + incremental line-by-line parsing of rg's `--json` stream (e.g. `node:readline` over `child.stdout`). No `maxBuffer` anywhere.
2. Early-stop conditions, checked per parsed event:
   - `matches.length >= maxResults` (existing condition — must keep identical result semantics for queries that hit it), or
   - a raw-consumption guard: stop after consuming more than `max(config.caps.search_chars * 8, 16MB)` bytes of rg stdout, whichever is larger, as a hard safety valve.
   On early stop: kill the child (SIGTERM), drain/cleanup, and return the matches collected so far. Downstream shaping (`limit_hit`, `omitted`, suggestion) must behave exactly as today when `maxResults` is the stopper.
3. Process hygiene: no unhandled 'error' events, no unhandled rejections on kill/EPIPE, child always reaped (await close/exit) — including when the consumer returns early. rg exit code 1 (no matches) is not an error; preserve the existing catch/fallback semantics for real failures (exit 2, missing binary) exactly as the current `catch` block does.
4. Behavior for everything under the cap must be byte-identical to today: ranking, context-line stitching (`contextBefore`/`contextAfter` maps), filters, per-root iteration.

## Out of scope

- Tool schemas, server, CLI, skills, prompts, README (other beads own those).
- The `args` length / E2BIG risk from passing every file path to rg — note it as a follow-up in your report if you confirm it, do not fix it.
- `buildGitRecencyCache`'s execFile (bounded output, fine as is).

## TDD (mandatory, in this order)

1. FIRST write a regression test that builds a temp corpus whose broad-pattern rg `--json` output decisively exceeds the current maxBuffer (e.g. several hundred files × dozens of matching lines with long text — compute and assert the corpus would emit > 4MB of JSON events). Run it against the CURRENT implementation and confirm it fails with the maxBuffer error.
2. Then implement streaming and make it pass: the same query returns a shaped, capped result (`limit_hit` true via max_results) with no exception, in bounded time.
3. Add a test asserting early termination leaves no live rg child (pragmatic check: the search promise resolves quickly — well under what full-corpus streaming would take — and/or instrument the spawned pid and assert it is dead after resolution).
4. All existing search/core tests pass unchanged.

Keep the temp corpus generation fast (<5s) and deterministic; clean up temp dirs.

## Constraints

- NEVER run mutating git commands (no add/commit/push/branch/restore). Read-only git is fine. The supervisor commits.
- NEVER touch `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` or anything outside this worktree.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`.
- No new dependencies; `node:` builtins only.
- Match existing code style; comments only for constraints the code can't show.

## Gates before you finish

```sh
pnpm build && pnpm format:check && pnpm test
```

If `format:check` fails, run `pnpm format` and re-check.

## Final report (your last message)

- Changes made (brief).
- Test commands run and pass/fail counts, including proof the regression test failed pre-fix.
- Measured runtime of the regression test.
- Assumptions/risks (signal handling, platform differences) and follow-up recommendations (e.g. E2BIG arg-list finding).
