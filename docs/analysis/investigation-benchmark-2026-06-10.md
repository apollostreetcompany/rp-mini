# Investigation Benchmark - rp-mini vs RepoPrompt vs Shell

Date: 2026-06-10

Target: `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`

Workspace: `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini`

## Purpose

Benchmark three ways to investigate RepoPrompt CE as rp-mini's ancestor:

1. Install workspace-local rp-mini and run the `/rp-investigate` workflow against CE.
2. Use normal RepoPrompt and run the equivalent `rp-investigate` investigation.
3. Run a non-RepoPrompt shell/Codex investigation.

The comparison focuses on wall-clock time, setup/runtime friction, evidence quality, and usefulness for guiding rp-mini's preserve/simplify/improve decisions.

## Methodology

Three shell-capable Codex subagents were launched in parallel from the rp-mini workspace with CE added as an extra readable directory. Each subagent read the project contract files first and wrote exactly one investigation report under `handoff/bead-13/agents/`.

Wall-clock time is measured from each subagent's recorded UTC start to recorded UTC end. These numbers include read gates, setup, investigation, synthesis, and writing the report. Tool-level timings were recorded when the route exposed useful measurable checkpoints.

There were two benchmark false starts worth recording:

- RepoPrompt Agent Mode subagents were first attempted, but that surface did not provide shell access in this context. That made it invalid for the install/build/timing portions of this benchmark, so those sessions were cancelled or ignored as benchmark inputs.
- The first Codex CLI launches used incompatible approval/sandbox flags. The working invocation used `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust exec ...`.

## Results Summary

| Route | Wall clock | Main timed checkpoints | Quality score | Best at | Main friction |
| --- | ---: | --- | ---: | --- | --- |
| rp-mini installed workflow | 237s | build 0.25s; install via bash 0.10s; cold CE index 45.54s; warm CE index 0.66s | 7/10 | Validating rp-mini cache/install substrate and extracting ancestor lessons with local artifacts | Active Codex process could not hot-load newly installed slash command/MCP config |
| Normal RepoPrompt | 638s | bind 0.0303s; CE tree 0.0408s; `context_builder` 447.7137s; broad codemap 0.1101s | 8/10 | Curated, high-signal architectural map and workflow-shaped synthesis | Slow context-builder run; multiple-window binding; some advertised tools unavailable in Codex namespace |
| Shell/Codex only | 155s | `rg --files` 0.02s; broad semantic `rg` 0.04s but 6,638 noisy lines | 8/10 | Raw speed and precise targeted file:line evidence once paths are known | No codemap/selection guardrails; broad searches flood the transcript and require manual triage |

## Route 1: rp-mini Installed Workflow

The rp-mini subagent built the workspace, installed the Codex plugin into a sandboxed `CODEX_HOME`, and indexed CE with rp-mini:

- `pnpm build`: 0.25s.
- `bash packages/codex-plugin/install.sh --write-config`: 0.10s.
- Cold index of CE: 45.54s.
- Warm index of CE: 0.66s.
- CE corpus indexed: 1,758 files, 354 dirs, 8 ignored on warm run.
- Codemaps: 1,427 cached on warm run, 331 skipped/gated.

This is the most important shakedown result for rp-mini itself. The warm-cache path is excellent, while the cold codemap path is still expensive enough to shape product expectations. The install worked, but `install.sh` was not executable in this checkout, so direct execution failed with `Permission denied`; running it through `bash` succeeded.

The route was not a true live `/rp-investigate` invocation inside the current Codex process. The installed skill and MCP config were written successfully, but this already-running process could not reload `CODEX_HOME` to discover the new slash workflow. The subagent therefore manually followed the installed rp-mini investigation workflow using the generated index artifacts plus shell reads.

Performance verdict: strong substrate benchmark, incomplete slash-command benchmark.

Quality verdict: good evidence and excellent cache receipts, but more manual than the intended product loop.

## Route 2: Normal RepoPrompt

The normal RepoPrompt subagent used RepoPrompt MCP after binding the correct two-root context. Its key result was a high-quality Context Builder map of CE's MCP, Context Builder, codemap, search, selection, edit, git, and agent-runtime surfaces.

Measured checkpoints:

- First roots call returned a bind-context warning because multiple RepoPrompt windows were open.
- Binding to rp-mini plus CE roots took 0.0303s.
- CE folder tree to depth 3 took 0.0408s.
- `context_builder` with `response_type:"question"` took 447.7137s.
- Broad codemap over five CE areas took 0.1101s, with 8 codemaps shown and 109 omitted.

The route had the best guided synthesis. It surfaced the durable product principle that "the selection is the universe", connected context-builder prompts to selection/token verification, and gave a clean preserve/simplify/improve map.

Performance verdict: slowest by far, with most of the time concentrated in Context Builder.

Quality verdict: best guided architecture map; good enough to justify the latency when the task needs curated context rather than raw file discovery.

## Route 3: Shell/Codex Only

The shell-only subagent was fastest and produced surprisingly strong evidence because the target concepts were searchable and the agent stayed disciplined about file:line citations.

Measured checkpoints:

- `rg --files | wc -l`: 1,823 files in 0.02s.
- Broad semantic `rg`: 0.04s, but 6,638 lines of output.
- Targeted `find`, `rg`, `nl`, and `sed` commands supplied the final line evidence.

Shell excelled at direct inventory and targeted reads. It struggled at the phase where RepoPrompt/rp-mini are meant to help: turning a huge semantic result set into a bounded, representative, token-safe context. The agent had to manually recover from noisy searches and guessed paths.

Performance verdict: fastest wall clock.

Quality verdict: strong with an experienced investigator, but least ergonomic and easiest to under-sample.

## Cross-Route Findings

Normal RepoPrompt is the highest-quality investigation route when latency is acceptable. It is especially valuable for broad unknown systems because Context Builder forces selection, prompt shaping, and token-aware synthesis.

Shell is the best raw stopwatch route. For known terms in a repo with good naming, it can beat specialized tooling. Its weakness is not command speed; it is human/agent attention management after broad searches.

rp-mini is already credible as a context-engine substrate. The cold/warm index numbers show the intended cache story works, and the installed plugin artifacts are real. The shakedown exposed product gaps rather than architectural failure: hot-load story, CLI discoverability, installer executable bit, and first-use codemap latency.

## What rp-mini Should Preserve From CE

- The 10-tool core surface: `file_search`, `read_file`, `get_file_tree`, `get_code_structure`, `manage_selection`, `workspace_context`, `prompt`, `apply_edits`, `file_actions`, and `git`.
- Selection as the universe: full files, slices, codemap-only entries, token accounting, selected tree, and workspace snapshots.
- Context Builder as a workflow contract: explore broadly, curate selection, rewrite/clarify the prompt, verify token budget, and export a receipt.
- Codemap behavior: line-numbered signatures, marker legends, auto references from selected files to referenced type definitions, and output caps.
- Safety behavior: read-only git by default, safe git flags, fail-closed `apply_edits`, ambiguity rejection, and structured path errors.
- Performance controls: cached codemaps, freshness checks, broad-search caps/backpressure, and deterministic receipts.

## What rp-mini Should Simplify Away

- CE's SwiftUI/window/compose-tab routing and compatibility matrix.
- App-managed agent lifecycle, steering queues, transcript rendering, oracle chat coupling, and model catalog ownership.
- GUI approval flows for edits; host approval policy should govern rp-mini writes.
- CE's full worktree/JJ/snapshot-retention machinery unless a later requirement proves it is needed.
- Debug/app daemon complexity; rp-mini should stay a host-agnostic context engine with benchmark and stress harnesses.

## What rp-mini Should Improve Next

- Add a true noninteractive smoke path for installing and immediately invoking the Codex skill/MCP server in a fresh process.
- Fix installer ergonomics by making `install.sh` executable or documenting `bash install.sh` as the supported invocation.
- Add CLI help/discovery; `node packages/server/dist/cli.js --help` currently returns `Unknown command: --help`.
- Reduce first-use codemap latency with parallel warmup, lazy grammar loading, and on-demand codemap generation.
- Stream or cap ripgrep output before Node subprocess buffers fill; Bead 12 already exposed broad-search `maxBuffer` risk.
- Emit benchmark/export receipts with hashes, selected modes, token breakdown, git state, and timing metadata.

## Side Effects And Receipts

Primary report artifacts:

- `handoff/bead-13/agents/01-rp-mini-investigate.md`
- `handoff/bead-13/agents/02-repoprompt-investigate.md`
- `handoff/bead-13/agents/03-shell-investigate.md`

Subagent prompts:

- `handoff/bead-13/prompts/01-rp-mini-investigate.md`
- `handoff/bead-13/prompts/02-repoprompt-investigate.md`
- `handoff/bead-13/prompts/03-shell-investigate.md`

Sandboxed rp-mini Codex install:

- `handoff/bead-13/rp-mini-codex-home/skills/rp-mini-context-builder/SKILL.md`
- `handoff/bead-13/rp-mini-codex-home/skills/rp-mini-rp-investigate/SKILL.md`
- `handoff/bead-13/rp-mini-codex-home/config.toml`

The rp-mini index command created `.rp-mini/` in the CE checkout because the requested shakedown indexed `../repoprompt-ce` directly. That generated cache was left in place; no cleanup was performed.

## Final Verdict

The shakedown passes for rp-mini as a context-engine substrate, not yet as a complete hot-loaded slash workflow in an already-running Codex session.

For this task, the ranking is:

1. Best raw speed: shell/Codex only, 155s.
2. Best warm-cache engine signal: rp-mini, 0.66s warm index after a 45.54s cold index.
3. Best guided investigation quality: normal RepoPrompt, 447.7s Context Builder inside a 638s total run.

The strategic takeaway is clear: rp-mini should keep RepoPrompt's selection/codemaps/context-builder contract, avoid inheriting CE's app-runtime complexity, and invest next in first-use latency plus fresh-process plugin invocation.
