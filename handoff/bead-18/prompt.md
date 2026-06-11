# Bead 18 — Edit verification loop: dry_run preview, hash-gated apply, post-apply proof

You are the implementation engineer for bead 18 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-18-edit-verification` in a dedicated git worktree.

## Why

rp-mini's `apply_edits` is fail-closed at MATCH time but blind at WRITE time: it writes directly with no preview step, no guarantee the file didn't change since the agent last read it, and no proof in the response that the final file states what the agent intended. RP-CE treats edit application as preview → approve → apply with freshness barriers. We are porting that discipline headless: the approval decision belongs to the host (agent, human, or CI gate), but the engine must offer preview, enforce freshness, and return verification proof. This closes an internal editing loop: propose → approve → apply → verify → retry on structured failure.

## Hardened-code rule (mandatory)

RP-CE at `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` is battle-tested reference code — READ-ONLY, never modify, never run its builds. Before implementing, study how CE handles edit preview/approval and freshness around mutation: start from `Sources/RepoPrompt/Features/.../ApplyEditsEngine.swift` and `rg -n "preview|approval|dry|stale|fingerprint" Sources/RepoPrompt/Infrastructure/MCP/` to find the MCP edit tool semantics. In your final report, state what CE's mechanism is and where you deviated and why. Port the mechanism; do not invent a simpler one silently.

## Owned paths (you may modify ONLY these)

- `packages/core/src/edits/index.ts` and `packages/core/src/edits/*.test.ts`
- `packages/server/src/index.ts` (apply_edits + file_actions schema/handler additions only)
- `packages/server/src/server.test.ts` (apply_edits/file_actions scenarios) or a new focused test file
- `README.md` (tools table rows for the new params)

## Spec

1. **`dry_run` preview.** `apply_edits` gains optional `dry_run: boolean` (default false). When true: run the ENTIRE ladder (literal → escape-decode → fuzzy, ambiguity rejection, transactional batch span computation) and return everything the real apply would, including `unified_diff`, but write NOTHING — and say so via `status: "previewed"`.
2. **Hash-gated apply.** `apply_edits` gains optional `expected_sha256: string`. When provided, compute the current file's content sha256 BEFORE matching; on mismatch return structured error `{ error: { code: "stale_file", expected_sha256, actual_sha256 } }` and write nothing. Every response (preview and apply) includes `pre_sha256` so the preview→apply handshake is: preview returns `pre_sha256`, host approves, apply passes it as `expected_sha256`.
3. **Post-apply verification proof.** After a real write, re-read the file and include in the response: `post_sha256`, `verified: true` (re-read content === the content the engine intended to write; if it does not match, report `verified: false` with error code `post_write_mismatch` — this should be impossible, which is why we check), and `post_context`: for each applied edit, a small slice of the FINAL file (the replaced span plus ~3 lines of context, line-numbered) so the calling agent sees the actual result without a follow-up read.
4. **Status taxonomy.** Responses carry `status: "previewed" | "applied"`; failures keep existing structured codes (`no_match`, `ambiguous_match`, …) plus new `stale_file` and `post_write_mismatch`. Batch edits remain transactional: any failure in the batch = nothing written (existing behavior — do not regress).
5. **`file_actions` freshness guards.** `delete` and `move` gain optional `expected_sha256` with the same `stale_file` semantics. `create` is unchanged.
6. **Interplay with existing behavior:** rewrite mode supports `dry_run` and `expected_sha256` too. Post-mutation refresh hooks (catalog memo, codemap eviction, selection refresh) must run only on real writes, never on dry runs. `root` targeting (bead 15) must work with all new params.
7. README: document the loop in 2–3 sentences in the tools table area: preview with dry_run → apply with expected_sha256 → verify from post_context.

## Out of scope

- Search, tree, packager, prompts/skills (other beads own those).
- Any change to ladder matching thresholds or algorithms.
- CE repo: read-only study only.

## TDD (mandatory, in this order)

Write failing tests FIRST and confirm the failure reason. Required scenarios:

1. `dry_run: true` returns `status: "previewed"` + `unified_diff` + `pre_sha256`; file content on disk is byte-identical afterward.
2. Preview→apply handshake: apply with `expected_sha256` = preview's `pre_sha256` succeeds with `status: "applied"`, `verified: true`, correct `post_sha256`, and `post_context` containing the replaced text with line numbers.
3. Staleness: modify the file between preview and apply → apply returns `stale_file` with both hashes; file untouched by the failed apply.
4. Transactional batch + dry_run: multi-edit batch previews all spans, writes nothing.
5. Batch staleness: `expected_sha256` mismatch on a batch apply writes nothing.
6. `file_actions` delete/move honor `expected_sha256` (`stale_file` on mismatch, file intact).
7. Dry runs do NOT invalidate codemap cache or selection state; real applies still do (extend existing refresh tests minimally).
8. Works with `root`-targeted workspaces (one scenario through the MCP linked transport).
9. All pre-existing tests pass unchanged.

## Constraints

- NEVER run mutating git commands (no add/commit/push/branch/restore). Read-only git is fine. The supervisor commits.
- NEVER modify `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`, CI config.
- No new dependencies (`node:crypto` for sha256).
- Match existing code style and error-shape conventions.

## Gates before you finish

```sh
pnpm build && pnpm format:check && pnpm test
```

If format:check fails, run `pnpm exec prettier --write` on your files and re-check.

## Final report (your last message)

- CE mechanism studied (files/lines) and how the port maps to it; deviations argued.
- Changes made (file-by-file, brief).
- Test commands run, red-phase proof, pass/fail counts.
- Assumptions/risks and follow-up recommendations.
