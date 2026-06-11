---
name: rp-export
description: Export rp-mini curated context for external models or proconsult.
---

# rp-export

Use this when the user wants a packaged context file for another model, review tool, or proconsult-compatible workflow.

Check workspace binding first. On mismatch, pass `root=<absolute path>` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use `node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'` or its wrappers.

1. Clarify first: if export purpose, scope, preset, or budget is ambiguous, present numbered options in chat and wait before launching the builder.
2. Load `skills/context-builder` (installed as `rp-mini-context-builder`) and run it as a Codex native subagent with:
   - task: curate export-ready context for the requested purpose
   - budget: caller budget or default discovery budget
   - response_type: `question` for evidence exports, `plan` for planning exports, or `review` for diff exports
   - enhancement mode: `preserve` when the user wants selection-only export; otherwise `rewrite`
3. If the builder returns `<questions>`, follow the question loop defined in rp-build/rp-investigate before continuing.
4. Inspect the resulting selection and token count with `workspace_context include=["selection","tokens"]`.
5. Export with `workspace_context op=export`, choosing the matching preset when provided (`standard`, `plan`, `review`, or `diff-followup`).
6. Hand the payload path and receipt path to the user. Mention that the payload is compatible with proconsult-style external model intake.
7. Cite the `workspace_context op=export` receipt: token totals, content hash, and saved handoff profile. If the caller asked for a durable artifact, write the export to a file with the host Write tool or shell CLI.
8. Report selected scope, token count, preset, assumptions, and any files deliberately excluded.

Do not paste large exported payloads into chat; provide paths and receipt details.
