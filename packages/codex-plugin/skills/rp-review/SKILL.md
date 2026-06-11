---
name: rp-review
description: Code review workflow using rp-mini git context and context-builder.
---

# rp-review

Use this when the user asks for a code review, PR review, diff review, or comparison against another ref.

Check workspace binding first. On mismatch, pass `root=<absolute path>` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use `node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'` or its wrappers.

1. Survey changes with `git` status/log/diff and infer comparison scope.
2. Clarify first: if the comparison target is ambiguous or missing, present numbered options in chat and wait before launching the builder.
3. Load `skills/context-builder` (installed as `rp-mini-context-builder`) and run it as a Codex native subagent with:
   - task: review the confirmed comparison scope, including current branch and key changed files
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: `review`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. If the builder returns `<questions>`, follow the question loop defined in rp-build/rp-investigate before continuing.
5. Act on the handoff: review diff context and affected-but-unchanged sources together.
6. Judge correctness, security, API/contracts, tests, maintainability, and consistency with existing patterns.
7. Finish with a `workspace_context op=export` receipt: token totals, content hash, and saved handoff profile.
8. Report findings first, ordered by severity, with file:line references and concrete fixes. Keep summary secondary.

Do not provide review feedback before `context-builder` has built review-mode context unless the user explicitly requested a quick/manual review.
