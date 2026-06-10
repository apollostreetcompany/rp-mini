---
name: rp-refactor
description: Scoped refactoring workflow using rp-mini context-builder.
---

# rp-refactor

Use this for safe behavior-preserving improvements to code organization, duplication, or complexity.

1. Clarify first: if the target area, behavior-preservation boundary, or acceptable risk is ambiguous, present numbered options in chat and wait before launching the builder.
2. Do a quick scan of the named areas with `get_file_tree`, `file_search`, or `get_code_structure`.
3. Load `skills/context-builder` (installed as `rp-mini-context-builder`) and run it as a Codex native subagent with:
   - task: analyze the target area for refactoring opportunities while preserving behavior
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: `review`
   - enhancement mode: `rewrite` unless the user requested `augment` or `preserve`
4. If the review identifies concrete work, rerun `context-builder` with response_type: `plan` for the chosen refactor.
5. Act on the handoff: implement scoped improvements only, one logical change at a time.
6. Validate behavior with existing and targeted tests; broaden tests if shared contracts changed.
7. Report what changed, what stayed intentionally unchanged, validations, and residual risk.

Do not use refactor as a vehicle for unrelated cleanup.
