---
name: rp-build
description: Build workflow using rp-mini context-builder before implementation.
---

# rp-build

Use this when the user wants code changes and the task benefits from curated context.

Check workspace binding first. On mismatch, pass `root=<absolute path>` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use `node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'` or its wrappers.

1. Verify the workspace is the intended repo and make a quick scan with `get_file_tree`, `file_search`, or `get_code_structure`.
2. Clarify first: if task scope, target behavior, or acceptance criteria are ambiguous, ask the user with AskUserQuestion before spawning the builder.
3. Spawn the `context-builder` subagent with:
   - task: reformulated user request with codebase terms from the quick scan
   - budget: default 120k for plan work unless caller supplied a hard budget
   - response_type: `plan`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. Question loop: this is the rp-build/rp-investigate question loop. If the builder returns `<questions>` plus a saved profile name, read the cited files, check git history or searches, and answer only conclusive questions with `<answer key="..." source="orchestrator" >...</answer>`. Escalate with AskUserQuestion only for blocking AND high-stakes questions: irreversible/destructive actions, product policy, money/auth/data-loss. Append `<answers>` with `prompt op=append`, resume with `manage_selection op=load_profile`, and remember advisory questions never interrupt.
5. Act on the handoff: implement directly against the curated selection and plan. Use existing repo patterns and avoid unrelated refactors.
6. Validate with relevant tests, lint/format, or build commands for the touched area.
7. Report changes, validation results, assumptions, and remaining risks.

Do not skip `context-builder` for non-trivial code work; the quick scan is orientation, not the deep exploration.
