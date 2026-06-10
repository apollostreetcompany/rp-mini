You are subagent 3 for rp-mini Bead 13 benchmark.

Read first, in this order, before doing any investigation:
1. /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/AGENTS.md
2. /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/CONTINUITY.md
3. /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/MISTAKES.md
4. /Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce/AGENTS.md

Goal: run a non-RepoPrompt investigation against the CE ancestor checkout using ordinary shell/file/git tools only, then write a benchmark report.

Owned output path:
/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/handoff/bead-13/agents/03-shell-investigate.md

Allowed writes:
- /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/handoff/bead-13/agents/03-shell-investigate.md
- temporary files under /tmp

Do not edit source files, docs, CONTINUITY.md, MISTAKES.md, or ../repoprompt-ce. Do not stage, commit, push, launch apps, or run destructive commands.

Tool route under test:
- Use shell/file/git commands only: `rg`, `rg --files`, `sed`, `awk`, `wc`, `find`, `git grep`, `git log`, `git show`, etc.
- Do not use normal RepoPrompt MCP/CLI tools.
- Do not use rp-mini CLI, rp-mini installed skills, or rp-mini-generated artifacts.

Common investigation question for all agents:
Investigate RepoPrompt CE as rp-mini's ancestor. Where does CE implement context discovery / context-builder behavior, MCP navigation surfaces (tree/search/read/codemaps/selection/workspace context/apply edits/git), and multi-agent performance/concurrency infrastructure? What should rp-mini preserve, simplify, or improve based on concrete CE evidence?

Benchmark requirements:
- Record start_utc, end_utc, wall_clock_seconds for your whole run. Use UTC timestamps.
- Record shell command timings/checkpoints where useful.
- Record files inspected with file:line evidence. Prefer concrete line refs.
- Include findings, unknowns, tool friction, and a candid quality self-score (0-10) with rationale.
- Include exact commands/queries used, but do not paste huge logs.
- Final report must be Markdown at the owned output path.

When done, reply with only the report path and a 5-line summary.
