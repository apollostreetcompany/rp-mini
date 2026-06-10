---
name: rp-build
description: Build workflow using rp-mini context-builder before implementation.
---

# rp-build

Use this when the user wants code changes and the task benefits from curated context.

Check workspace binding first. On mismatch, pass `root=<absolute path>` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use `node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'` or its wrappers.

1. Verify the workspace is the intended repo and make a quick scan with rp-mini tools such as `get_file_tree`, `file_search`, or `get_code_structure`.
2. Clarify first: if task scope, target behavior, or acceptance criteria are ambiguous, present numbered options in chat and wait before launching the builder.
3. Load `skills/context-builder` (installed as `rp-mini-context-builder`) and run it as a Codex native subagent with:
   - task: reformulated user request with codebase terms from the quick scan
   - budget: default 120k for plan work unless caller supplied a hard budget
   - response_type: `plan`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. Act on the handoff: implement directly against the curated selection and plan. Use existing repo patterns and avoid unrelated refactors.
5. Validate with relevant tests, lint/format, or build commands for the touched area.
6. Report changes, validation results, assumptions, and remaining risks.

Do not skip `context-builder` for non-trivial code work; the quick scan is orientation, not the deep exploration.
