---
name: rp-plan
description: Deep planning workflow using rp-mini context-builder.
---

# rp-plan

Use this when the user asks for a plan document before implementation.

1. Clarify first: if goals, constraints, target audience, or involvement level are ambiguous, ask with AskUserQuestion before spawning the builder.
2. Create or update `docs/plans/<topic>-<YYYY-MM-DD>.md` only after the plan scope is clear.
3. Spawn the `context-builder` subagent with:
   - task: produce architectural planning context for the requested topic
   - budget: 120k default for plan unless caller supplied a hard budget
   - response_type: `plan`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. Act on the handoff: write the plan document in your own concise voice, grounded in selected files and file:line references.
5. Include goal, constraints, architecture, work items, validation, risks, and open questions.
6. Validate non-code quality: internal paths resolve, assumptions are labeled, and the plan matches current repo state.
7. Report the plan path and the key tradeoffs.

Do not implement code in this workflow.
