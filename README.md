# rp-mini

A minimal, configurable context-engineering plugin for coding agents — RepoPrompt's best ideas without the app.

- **MCP server (TypeScript)**: 10 token-capped tools — `file_search`, `read_file`, `get_file_tree`, `get_code_structure`, `manage_selection`, `workspace_context`, `prompt`, `apply_edits`, `file_actions`, `git`.
- **Claude Code plugin**: context-builder subagent + `rp-*` skills.
- **Codex plugin**: subagent config + skills, same shared prompts.

Design: [docs/plans/rp-mini-design-2026-06-10.md](docs/plans/rp-mini-design-2026-06-10.md).

Portions of the design and algorithms are derived from [RepoPrompt CE](https://github.com/repoprompt/repoprompt-ce) (Apache 2.0). See THIRD_PARTY_NOTICES.md (added with the first release bead).

Status: pre-alpha, under active construction.
