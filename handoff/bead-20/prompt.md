# Bead 20 — Question-loop contract: typed questions out, evidence-based answers back

You are the implementation engineer for bead 20 of rp-mini. Read AGENTS.md, CONTINUITY.md, MISTAKES.md in this worktree first. You are on branch `codex/feat/bead-20-question-loop` in a dedicated git worktree.

## Why

When a context-builder subagent hits ambiguity mid-run today, its only outlet is the free-text `<ambiguities>` section. RP-CE supports structured human interrupts through its app UI; rp-mini is headless, so we port the PATTERN, not the UI: the subagent RETURNS a typed question set and halts cleanly (selection profile already saved per the bead-16 contract); the orchestrating skill answers every question it can definitively from evidence; ONLY questions that are blocking AND high-stakes (irreversible, destructive, product-policy) interrupt the human. Answers feed back into the stored prompt, and the builder consumes them on resume via `load_profile`. This makes long autonomous runs robust without losing curated state or over-interrupting people.

## Reference (read-only)

RP-CE at `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce` is READ-ONLY reference. Briefly study how CE structures its interrupt/question contract (`rg -n "question|interrupt|clarif" Sources/RepoPrompt/Infrastructure/MCP/ Sources/RepoPrompt/Features/ContextBuilder/` ; look for schemas with keyed answers, options, timeout/skipped states). Mirror its schema vocabulary (keys, options, defaults, skipped/timeout semantics) in our XML contract where it maps; note deviations in your report.

## Owned paths (you may modify ONLY these)

- `shared-prompts/discovery/contract.md`
- `packages/cc-plugin/scripts/build-prompts.mjs` (only if generation needs it)
- `packages/cc-plugin/agents/context-builder.md` — GENERATED via `pnpm build:prompts`, never hand-edit
- `packages/cc-plugin/skills/*/SKILL.md`
- `packages/codex-plugin/scripts/build-prompts.mjs` and generated `packages/codex-plugin/skills/*/SKILL.md`
- `packages/cc-plugin/src/*.test.ts`, `packages/codex-plugin/src/plugin.test.ts`

## Spec

1. **Contract: `<questions>` block.** New optional section in the handoff format, after `<ambiguities>`:

```xml
<questions>
<question key="migration-backfill" severity="blocking" default="separate-job">
Should the user-table migration backfill existing rows inline?
<option value="inline">Backfill in the same migration</option>
<option value="separate-job">Separate backfill job</option>
<evidence>db/migrate/20260601_users.rb; docs/runbooks/migrations.md</evidence>
</question>
</questions>
```

Rules for the builder (contract text): keys are stable kebab-case; `severity` is `blocking` (cannot proceed safely without an answer) or `advisory` (proceeding with `default`, flagging it); every question carries a `default` and evidence pointers; the builder STILL completes the best selection it can and saves the handoff profile before halting — questions never excuse an empty selection; advisory questions never block.

2. **Contract: consuming `<answers>` on resume.** Define the answers block the host appends to the stored prompt (`prompt op=append`):

```xml
<answers>
<answer key="migration-backfill" source="orchestrator|user" >separate-job</answer>
</answers>
```

Contract instructs the builder: on start, read the existing prompt; if `<answers>` are present, treat them as binding decisions, refine the loaded selection accordingly, and do not re-ask answered keys. Unanswered advisory keys → proceed with defaults and keep them listed.

3. **Skills: orchestrator triage loop (all rp-* skills, both plugins; concise — a few lines each, with the full loop spelled out once in rp-build and rp-investigate and referenced from the others).** The loop: (a) builder returns questions + saved profile name; (b) for each question, attempt a DEFINITIVE answer from evidence — read the cited files, check git history, run searches; answer only when evidence is conclusive, recording `source="orchestrator"`; (c) escalate to the human ONLY questions that are `blocking` AND high-stakes (irreversible/destructive actions, product policy, money/auth/data-loss) — in Claude Code use AskUserQuestion; in Codex present numbered options in chat and wait; (d) append `<answers>` via `prompt op=append`; (e) resume the builder with `manage_selection op=load_profile` + the updated prompt; (f) advisory questions never interrupt a human — proceed with defaults and surface them in the final report/receipt.
4. **Tests (TDD).** Plugin tests assert: contract contains the `<questions>`/`<answers>` grammar, severity vocabulary, "complete the selection and save the profile before halting", and the do-not-re-ask rule; generated cc agent + codex builder skill stay in sync; rp-build and rp-investigate contain the triage loop incl. the blocking+high-stakes human gate; every rp-* skill references the question loop. Mind the codex skill line cap (currently ≤90 in plugin.test.ts); raise deliberately to ≤110 only if genuinely needed and say so.
5. **Generated-file discipline:** `pnpm build:prompts` must leave `git status` clean apart from your intended source edits (the CI drift guard `git diff --exit-code` after build:prompts will enforce this — keep `config/mcp-servers.toml` emitting the `{{RP_MINI_SERVER_CLI}}` placeholder exactly).

## Out of scope

- Engine/server/core code — NO new MCP tools or schema changes; the loop runs entirely on existing primitives (`prompt op=append/get`, `manage_selection op=save_profile/load_profile`).
- README.
- CE repo: read-only.

## TDD (mandatory)

Write/extend failing assertions first, confirm they fail for the right reason, then edit prompts/skills and regenerate until green.

## Constraints

- NEVER run mutating git commands. Read-only git is fine. The supervisor commits.
- NEVER modify `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`.
- Do not edit `CONTINUITY.md`, `MISTAKES.md`, `handoff/*`, CI config.
- Builder allowlist stays non-mutating (no shell, no apply_edits/file_actions).
- Keep prose tight and imperative, matching existing voice.

## Gates before you finish

```sh
pnpm build && pnpm build:prompts && pnpm format:check && pnpm test
```

Run `git status --short` at the end; only intended files may be dirty.

## Final report (your last message)

- CE question/interrupt mechanism found (files/lines) and how the XML grammar maps to it; deviations argued.
- Changes made (file-by-file, brief).
- Test commands + red-phase proof + counts.
- Whether the line cap changed and why.
- Assumptions/risks and follow-ups.
