# Bead 13 Subagent 1 - rp-mini investigate benchmark

## Run Metadata

- start_utc: `2026-06-10T06:44:08Z`
- end_utc: `2026-06-10T06:48:05Z`
- wall_clock_seconds: `237`
- target: `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`
- route under test: workspace-local rp-mini Codex install plus manual `/rp-investigate` workflow follow-through
- normal RepoPrompt MCP used: `no`

## Setup And Command Timings

| Step | Command | Result | Timing |
| --- | --- | --- | --- |
| Build | `pnpm build` | `tsc -b` passed | `real 0.25s` |
| Direct installer attempt | `CODEX_HOME=... /usr/bin/time -p packages/codex-plugin/install.sh --write-config` | failed: `Permission denied` because `install.sh` is not executable | `real 0.00s` |
| Installer via bash | `CODEX_HOME=... /usr/bin/time -p bash packages/codex-plugin/install.sh --write-config` | succeeded, appended `[mcp_servers.rp-mini]` | `real 0.10s` |
| Cold index | `/usr/bin/time -p node packages/server/dist/cli.js index ../repoprompt-ce` | `1758 files, 354 dirs, 7 ignored; codemaps: 0 cached, 1427 computed, 331 skipped(gated)` | `real 45.54s` |
| Warm index | `/usr/bin/time -p node packages/server/dist/cli.js index ../repoprompt-ce` | `1758 files, 354 dirs, 8 ignored; codemaps: 1427 cached, 0 computed, 331 skipped(gated)` | `real 0.66s` |

Setup/install time separately: `0.35s` measured for build plus successful install; `0.10s` for install only. Verification reads were not separately timed.

Installed skill verification:

```text
handoff/bead-13/rp-mini-codex-home/skills/rp-mini-context-builder/SKILL.md
handoff/bead-13/rp-mini-codex-home/skills/rp-mini-rp-investigate/SKILL.md
```

Config verification:

```text
[mcp_servers.rp-mini]
command = "node"
args = ["/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/packages/server/dist/cli.js", "serve"]
```

## Hot-load Limitation

This already-running noninteractive Codex session could not hot-load the newly installed workspace-local `CODEX_HOME` skills or MCP server as a real `/rp-investigate` slash command. I therefore followed the installed `rp-mini-rp-investigate` and `rp-mini-context-builder` instructions manually: read the installed workflow, built/indexed rp-mini, used the rp-mini index artifacts, and gathered evidence with shell file reads. This is a real friction point for the benchmark: install succeeded, but runtime activation requires a fresh Codex process/config load.

## rp-mini Artifact Evidence

The rp-mini index produced:

- `.rp-mini/catalog.json`
- `.rp-mini/codemap-cache/*.json` with 1427 computed/cached codemaps

Catalog readback after warm index:

```json
{
  "root": "/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce",
  "files": 1758,
  "dirs": 354,
  "ignored": 8,
  "tookMs": 303.089208,
  "generatedAt": "2026-06-10T06:45:52.407Z"
}
```

Note: the required exact `node packages/server/dist/cli.js index ../repoprompt-ce` command writes `.rp-mini/` into the CE checkout. That conflicts with the "do not edit ../repoprompt-ce" spirit, but the benchmark instruction explicitly required the command.

## CE Evidence Map

### Context discovery and context-builder

CE implements Context Builder primarily in `Sources/RepoPrompt/Features/ContextBuilder`.

- `ContextBuilderDefaults` sets discovery budget `160_000`, plan budget `120_000`, default enhancement `.fullRewrite`, UI clarifying questions on, MCP clarifying questions off, and auto-plan off: `Sources/RepoPrompt/Features/ContextBuilder/Services/ContextBuilderDefaults.swift:13-41`.
- Budget resolution is centralized so response-producing runs use plan budget and clarify/discovery runs use discovery budget: `Sources/RepoPrompt/Features/ContextBuilder/Services/ContextBuilderBudgetResolver.swift:3-15`.
- The view model is the runtime owner: per-tab sessions, logs, MCP control token, prompt/selection snapshots, response type, and run state live in `ContextBuilderAgentViewModel`: `Sources/RepoPrompt/Features/ContextBuilder/ViewModels/ContextBuilderAgentViewModel.swift:97-260`.
- Workspace-scoped defaults and global agent/model selection are restored/persisted separately from per-tab context: `ContextBuilderAgentViewModel.swift:1378-1489`.
- MCP runs enter through `runContextBuilderForMCP`, which applies ephemeral overrides for instructions, budget, enhancement mode, agent, model, and response type, rejects concurrent runs for the same tab, and restores saved settings: `ContextBuilderAgentViewModel.swift:1517-1605`.
- MCP-controlled runs suppress UI auto-plan because follow-up generation is owned by the MCP caller: `ContextBuilderAgentViewModel.swift:3040-3064`.
- `question` response type maps to headless chat mode, while `plan` and `review` map to their own headless modes: `Sources/RepoPrompt/Features/ContextBuilder/ViewModels/ContextBuilderResponseType+Headless.swift:3-15`.
- CE's discovery system prompt is generated in code. It explicitly says Codex discovery has no filesystem access except RepoPrompt MCP tools, and mandates `prompt op=set` in rewrite mode with task/architecture/selected_context/relationships/ambiguities structure: `Sources/RepoPrompt/Infrastructure/AI/SystemPromptService.swift:47-59` and `SystemPromptService.swift:145-190`.
- Review mode adds a required `git diff artifacts=true` flow and selects both diff artifacts and source context: `SystemPromptService.swift:115-134`.

What rp-mini should preserve:

- The two-stage model: builder curates selection and writes a handoff prompt, later reasoning uses that curated universe.
- Distinct budgets for discovery vs follow-up.
- Enhancement modes: rewrite, augment, preserve.
- `response_type` semantics, especially `question -> chat`, `review -> diff-aware`.

What rp-mini should simplify:

- Remove CE's app/tab/UI persistence coupling. rp-mini can keep per-session state and exported receipts instead of the full `ContextBuilderAgentViewModel` state machine.
- Keep clarification at the calling skill level, as current rp-mini does, rather than embedding CE's UI/MCP ask-user machinery.

### MCP navigation surfaces

CE's tool catalog is explicit and larger than rp-mini's MVP:

- Stable names are in `MCPWindowToolName`: `manage_selection`, `file_actions`, `get_code_structure`, `get_file_tree`, `read_file`, `file_search`, `workspace_context`, `prompt`, `apply_edits`, `git`, `context_builder`, `agent_run`, `agent_manage`: `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPWindowToolNames.swift:3-35`.
- Group ordering puts selection first, then files, prompt/context, apply_edits, oracle, git, context_builder, ask_user, agent controls: `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPWindowToolGroup.swift:3-69`.
- `MCPServerViewModel` wires services/dependencies and routes agent run/manage/explore through service objects: `Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel.swift:171-330` and `MCPServerViewModel.swift:507-552`.
- File tools are provider objects. `MCPFileToolProvider` builds `file_actions`, `get_code_structure`, `get_file_tree`, `read_file`, and `file_search`: `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPFileToolProvider.swift:18-25`.
- `read_file` handles path translation, freshness/barrier waiting through dependencies, line slicing, and optional auto-selection: `MCPFileToolProvider.swift:304-369`.
- `file_search` parses mode/regex/context/filter/path limiters, translates session-bound worktree paths, calls workspace search, and handles backpressure/stale/unavailable errors: `MCPFileToolProvider.swift:447-535`.
- `manage_selection` supports get/add/remove/set/clear/preview/promote/demote, full/slices/codemap-only modes, auto-codemap behavior, fuzzy paths, and selection replies: `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPSelectionToolProvider.swift:22-64` and `MCPSelectionToolProvider.swift:104-150`.
- `workspace_context` assembles selection, files, code structure, tree, and token stats over the current tab/selection: `Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+WorkspaceContext.swift:3-180`.
- `apply_edits` is a destructive local tool with rewrite/single/batch modes and an engine using diff generation, patch application, escape fallback, and verbose diff output: `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPApplyEditsToolProvider.swift:25-75` and `Sources/RepoPrompt/Infrastructure/MCP/ApplyEdits/ApplyEditsEngine.swift:16-160`.
- `git` is read-only and supports status/diff/log/show/blame, compare specs, artifact publishing, repo targeting, and safe flags: `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPGitToolProvider.swift:44-135`.
- Git implementation bridges through `GitBackend` actor to `GitService` for repo discovery, status, worktrees, diffs, logs, show, and blame: `Sources/RepoPrompt/Infrastructure/VCS/GitBackend.swift:5-18`, `GitBackend.swift:188-318`.

What rp-mini should preserve:

- Stable tool names and high-level semantics for the 10-tool surface.
- Selection modes and delta accounting.
- `workspace_context` as the central receipt/snapshot/export tool.
- `git` as read-only by default with explicit artifact/export path.
- `apply_edits` fail-closed matching and transactional batch behavior.

What rp-mini should simplify:

- Avoid CE's window routing, active-tab compatibility, worktree projection, UI auto-selection, and oracle/chat coupling unless the host needs it.
- Keep tool schemas narrower. CE has many app-era compatibility branches that are not needed in a host-agnostic MCP server.

### Codemaps, file tree, search, and workspace context infrastructure

- CodeMap file tree rendering and codemap markers are centralized in `CodeMapExtractor`. It has selected and codemap markers, auto/MCP token budgets, bad dir filtering, and token-capped tree generation: `Sources/RepoPrompt/Features/CodeMap/CodeMapExtractor.swift:65-110`.
- The workspace store is an actor: `Sources/RepoPrompt/Infrastructure/WorkspaceContext/WorkspaceFileContextStore.swift:111-135`.
- Freshness barriers are scoped by root and concurrent requests share watermark-keyed flights; root waits are chunked with `withTaskGroup`: `WorkspaceFileContextStore.swift:820-905`.
- Codemap API aggregation is cached and exposed through `codemapSnapshotDictionary`: `WorkspaceFileContextStore.swift:1129-1175`.
- File tree snapshots resolve selected paths/slices through lookup and materialization before building the tree snapshot: `WorkspaceFileContextStore.swift:1344-1390`.
- Search content uses fingerprinted decoded-content cache before loading validated content: `WorkspaceFileContextStore.swift:2088-2148`.
- `WorkspaceSearchService` is actor-owned and keeps path indexes off the main actor, listens to applied index events, debounces rebuilds, discards stale completions, and reports readiness/staleness: `Sources/RepoPrompt/Infrastructure/WorkspaceContext/Search/WorkspaceSearchService.swift:3-180`.
- `PathSearchIndex` wraps a C implementation for path search with O(log n + k*m) intent and includes an actor LRU cache helper: `Sources/RepoPrompt/Infrastructure/WorkspaceContext/Search/PathSearchIndex.swift:6-8` and `PathSearchIndex.swift:132-172`.
- `CodeScanActor` limits scanning concurrency based on CPU, serializes tree-sitter parse/query phase through a capacity-1 limiter, batches progress/results, and uses root cache single-flight loading: `Sources/RepoPrompt/Features/CodeMap/CodeScanActor.swift:127-209`.
- `CodeMapCacheManager` fingerprints content with SHA-256 plus byte count and offloads JSON cache loads to detached utility tasks: `Sources/RepoPrompt/Features/CodeMap/CodeMapCacheManager.swift:6-20` and `CodeMapCacheManager.swift:65-128`.

What rp-mini should preserve:

- Actor/process isolation around mutable indexes and caches.
- Content-hash/mtime freshness checks.
- Scoped freshness barriers, but in a simpler filesystem snapshot model.
- Bounded codemap/file-tree output.
- Search readiness/staleness reporting rather than false-empty results.

What rp-mini should improve:

- Cold codemap warmup took `45.54s` on CE; warm is excellent at `0.66s`. rp-mini should focus on parallel warmup, lazy grammar loading, and partial/on-demand codemap generation for first-use latency.
- CE's search/read stack is robust but app-dependent. rp-mini should expose backpressure and cap behavior directly at MCP response boundaries. This aligns with the existing Bead 12 broad-search maxBuffer follow-up.

### Multi-agent performance and concurrency infrastructure

- CE has a repo-local developer daemon for human/agent build/test coordination. It defines lanes (`build`, `debugArtifact`, `liveApp`, `release`, `style`), timeouts, tickets, log retention, heartbeat behavior, and operation routing: `Scripts/conductor.py:34-63`, `Scripts/conductor.py:64-85`, `Scripts/conductor.py:727-758`.
- The daemon summarizes huge logs into structured sections instead of replaying raw output: `Scripts/conductor.py:433-560`.
- MCP server state tracks agent wait scopes, child session wait counts, tool execution counts, and idle waiters: `Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel.swift:993-1007`.
- Wait scopes are tokenized, counted by child session, ended with completion reasons, and stale-purged with a grace window: `MCPServerViewModel.swift:1330-1385`.
- Agent role prompts deliberately separate explore/engineer behavior and rely on ListTools/advertisement policy rather than hardcoded universal tool access: `Sources/RepoPrompt/Infrastructure/AI/Prompts/AgentModePrompts.swift:40-50`.
- Explore guidance emphasizes narrow probes, fan-out, waiting on detached sessions, and spot-checking load-bearing claims: `AgentModePrompts.swift:264-302`.
- CE's headless discovery provider config disables native filesystem/shell tools and uses strict MCP mode: `Sources/RepoPrompt/Infrastructure/AI/Providers/ClaudeCodeAgentConfig.swift:108-133`.
- Claude discovery disallows Bash/Read/Write/Edit/Glob/Grep/Task/etc. so discovery runs through MCP tools: `Sources/RepoPrompt/Infrastructure/AI/Providers/ClaudeCode/ClaudeCodeIntegrationConfiguration.swift:70-137`.
- Codex discovery can ensure a RepoPrompt MCP config entry exists disabled-by-default for normal use, then enabled by runtime overrides: `Sources/RepoPrompt/Infrastructure/AI/Providers/Codex/CodexIntegrationConfiguration.swift:199-231`.

What rp-mini should preserve:

- Per-session isolation plus shared caches.
- Role-specific instructions that reflect actual tool visibility.
- Explicit lifecycle/wait handles for any future delegated agent support.
- Strict discovery-mode tool constraints.

What rp-mini should simplify:

- Do not reproduce CE's app-managed agent UI, transcript renderer, worktree binding, or conductor. rp-mini should remain the context engine. Host harnesses should own agent lifecycle.
- Keep a small benchmark/stress harness instead of a full developer daemon.

## Findings

1. CE's "context builder" is not just a prompt. It is a product subsystem with per-tab state, MCP ownership tokens, budgets, prompt enhancement modes, provider selection, UI cancellation, and follow-up generation.
2. The essential ancestor behavior for rp-mini is smaller: discovery prompt + constrained tools + selection mutation + token gate + prompt rewrite/augment/preserve + export/receipt.
3. CE's MCP surface validates rp-mini's 10-tool choice. The stable core is files/search/tree/codemaps/selection/workspace_context/prompt/apply_edits/git.
4. CE's implementation has many app-specific complications: window routing, tab compatibility, worktree projections, auto-selection, UI cards, transcript state, and Oracle coupling. rp-mini should not inherit these.
5. CE's performance architecture is actor-heavy and cache-heavy. rp-mini's process-per-session plus atomic shared disk cache is directionally right, but cold codemap generation needs attention.
6. The local rp-mini Codex install works, but `install.sh` lacks executable bit in this checkout, and this active Codex session cannot hot-load the newly installed slash command/MCP config.

## Unknowns

- I did not run CE's live MCP server or app. Evidence is source-level only.
- I did not invoke a true rp-mini MCP `serve` session through Codex after install, because the current process cannot reload `CODEX_HOME`.
- I did not inspect every CE test for these systems; line references come from implementation files and targeted test/catalog search.
- The required rp-mini index command created `.rp-mini/` in the CE checkout; I did not remove it because destructive cleanup was out of scope.

## Tool Friction

- `packages/codex-plugin/install.sh` failed when executed directly: `Permission denied`. Running `bash packages/codex-plugin/install.sh --write-config` succeeded without changing file mode.
- `node packages/server/dist/cli.js --help` returns `Unknown command: --help`; discoverability for CLI commands is minimal.
- Broad `rg` over CE produced thousands of noisy matches. rp-mini's indexed artifacts helped establish corpus/cache facts, but the current CLI has no exposed search/read/tree commands, so manual shell reads still carried the investigation.
- The active Codex process cannot hot-load newly installed skills/MCP config, so this was an install-plus-manual-workflow benchmark rather than a true slash-command execution benchmark.

## Quality Self-score

Score: `7/10`.

Rationale: I captured install/build/index timings, verified installed files, followed the installed workflow as far as this noninteractive session allows, avoided normal RepoPrompt MCP, and grounded findings in concrete file:line evidence. The score is not higher because I could not execute the actual slash command or use rp-mini MCP tools interactively after install, and the rp-mini CLI currently only exposed `serve` and `index`, so the investigation relied heavily on shell reads after indexing.

## Commands Run

Key commands:

```bash
sed -n '1,240p' AGENTS.md
sed -n '1,240p' CONTINUITY.md
sed -n '1,240p' MISTAKES.md
sed -n '1,260p' ../repoprompt-ce/AGENTS.md
date -u +%Y-%m-%dT%H:%M:%SZ
git status --short --branch
pnpm build
CODEX_HOME=/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/handoff/bead-13/rp-mini-codex-home /usr/bin/time -p packages/codex-plugin/install.sh --write-config
CODEX_HOME=/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/handoff/bead-13/rp-mini-codex-home /usr/bin/time -p bash packages/codex-plugin/install.sh --write-config
find handoff/bead-13/rp-mini-codex-home/skills -maxdepth 1 -type d -name 'rp-mini-*' -print | sort
/usr/bin/time -p node packages/server/dist/cli.js index ../repoprompt-ce
/usr/bin/time -p node packages/server/dist/cli.js index ../repoprompt-ce
rg -n "context[-_ ]?builder|ContextBuilder|discover|discovery|selection|workspace_context|manage_selection|apply_edits|file_search|read_file|get_file_tree|get_code_structure|agent_run|agent_manage|multi.?agent|concurrency|daemon|cache|codemap|CodeMap|git" --glob '!**/.build/**' --glob '!**/.rp-mini/**' --glob '!**/DerivedData/**'
nl -ba <target files> | sed -n '<line ranges>'
```

Outputs that matter are summarized in the timing table and evidence sections above; huge search logs were intentionally not pasted.
