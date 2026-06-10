---
name: rp-investigate
description: Read-only investigation workflow using rp-mini context-builder.
---

# rp-investigate

Use this for root-cause analysis, code archaeology, or "how/why is this happening?" questions. This workflow is read-only.

1. Clarify first: if the symptom, environment, comparison point, or expected behavior is ambiguous, ask with AskUserQuestion before spawning the builder.
2. Record the investigation question, symptoms, hypotheses, and any user-provided evidence.
3. Spawn the `context-builder` subagent with:
   - task: investigation question plus symptoms and hypotheses
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: `question`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. Pursue evidence from the handoff: read selected files, inspect git history or diffs when relevant, and verify claims with file:line references.
5. Refine selection only when evidence shows the builder missed needed context; bias toward adding, not clearing, selection.
6. Report findings as evidence, inference, unknowns, and next recommended action.

Do not change source files in this workflow.
