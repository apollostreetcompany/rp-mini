---
name: rp-export
description: Export rp-mini curated context for external models or proconsult.
---

# rp-export

Use this when the user wants a packaged context file for another model, review tool, or proconsult-compatible workflow.

1. Clarify first: if export purpose, scope, preset, or budget is ambiguous, present numbered options in chat and wait before launching the builder.
2. Load `skills/context-builder` (installed as `rp-mini-context-builder`) and run it as a Codex native subagent with:
   - task: curate export-ready context for the requested purpose
   - budget: caller budget or default discovery budget
   - response_type: `question` for evidence exports, `plan` for planning exports, or `review` for diff exports
   - enhancement mode: `preserve` when the user wants selection-only export; otherwise `rewrite`
3. Inspect the resulting selection and token count with `workspace_context include=["selection","tokens"]`.
4. Export with `workspace_context op=export`, choosing the matching preset when provided (`standard`, `plan`, `review`, or `diff-followup`).
5. Hand the payload path and receipt path to the user. Mention that the payload is compatible with proconsult-style external model intake.
6. Report selected scope, token count, preset, assumptions, and any files deliberately excluded.

Do not paste large exported payloads into chat; provide paths and receipt details.
