---
name: rp-investigate
description: Read-only investigation workflow using rp-mini context-builder.
---

# rp-investigate

Use this for root-cause analysis, code archaeology, or "how/why is this happening?" questions. This workflow is read-only.

Check workspace binding first. On mismatch, pass `root=<absolute path>` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use `node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'` or its wrappers.

Triage fast path: Bounded question (single subsystem, named symbol, roughly <=5 files) -> answer inline with `file_search`, `read_file`, and `get_code_structure`; do not spawn the builder. Broad, cross-cutting, or durable-context-pack requests -> full builder flow. Both paths keep line-cited evidence.

1. Clarify first: if the symptom, environment, comparison point, or expected behavior is ambiguous, present numbered options in chat and wait before launching the builder.
2. Record the investigation question, symptoms, hypotheses, and any user-provided evidence.
3. Load `skills/context-builder` (installed as `rp-mini-context-builder`) and run it as a Codex native subagent with:
   - task: investigation question plus symptoms and hypotheses
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: `question`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. Pursue evidence from the handoff: read selected files, inspect git history or diffs when relevant, and verify claims with file:line references.
5. Refine selection only when evidence shows the builder missed needed context; bias toward adding, not clearing, selection.
6. Finish with a `workspace_context op=export` receipt: token totals, content hash, and saved handoff profile. If the caller asked for a durable artifact, write the export to a file with the host Write tool or shell CLI.
7. Report findings as evidence, inference, unknowns, and next recommended action.

Do not change source files in this workflow.
