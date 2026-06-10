## rp-mini Codex Usage

Use rp-mini MCP tools for context-heavy repository work:
- Prefer `file_search` over ad hoc grep/glob when searching paths or contents.
- Prefer `read_file` for bounded reads with line ranges.
- Prefer `get_file_tree` and `get_code_structure` for orientation before broad edits.
- Prefer `apply_edits` for precise file changes when the rp-mini MCP server is available.

Skill routing:
- `rp-investigate`: read-only root-cause analysis, archaeology, or how/why questions.
- `rp-plan`: deep planning before implementation.
- `rp-build`: non-trivial implementation work.
- `rp-refactor`: behavior-preserving structural changes.
- `rp-review`: code, PR, or diff review.
- `rp-export`: packaged context for external models or proconsult-style workflows.

Context-builder delegation:
- The rp-* skills first clarify user-facing ambiguity by presenting numbered options in chat and waiting.
- Then they load `rp-mini-context-builder` and run it as a Codex native subagent with task, budget, `response_type`, and enhancement mode.
- The builder curates selection and writes the handoff prompt. It must not implement.
