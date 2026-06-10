# Bead 13 Agent 03 - Shell Investigation of RepoPrompt CE

## Run Metadata

- route: non-RepoPrompt shell/file/git investigation
- start_utc: 2026-06-10T06:43:52Z
- end_utc: 2026-06-10T06:46:27Z
- wall_clock_seconds: 155
- cwd: `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini`
- target checkout: `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`
- branch inspected: `main`
- latest commit shown: `1db9bbc Merge pull request #129 from repoprompt/rp/agent/916c8b7d-agent`

## Commands / Checkpoints

Read gate, in requested order:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
sed -n '1,220p' /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/AGENTS.md
sed -n '1,220p' /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/CONTINUITY.md
sed -n '1,220p' /Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/MISTAKES.md
sed -n '1,220p' /Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce/AGENTS.md
wc -l .../AGENTS.md .../CONTINUITY.md .../MISTAKES.md
sed -n '221,520p' /Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce/AGENTS.md
```

Investigation commands used:

```bash
/usr/bin/time -p rg --files | wc -l
/usr/bin/time -p rg -n "context[-_ ]?builder|ContextBuilder|..." Sources Tests .agents docs Package.swift Makefile
git status --short && git branch --show-current && git log --oneline -5
find Sources -maxdepth 4 -type d | sort
find Sources/RepoPrompt -maxdepth 5 -type f | sort | rg 'ContextBuilder|WorkspaceContext|CodeMap|MCP|AgentMode|Diffing|VCS|Search'
rg -n "name:\\s*\\\"(file_search|read_file|...)" Sources/RepoPrompt/Infrastructure/MCP Sources/RepoPromptShared/MCP Sources/RepoPromptMCP
rg -n "class ContextBuilder|AgentProviderContextBuilder|context_builder|initialFileTree|forkFileContentsBlock" ...
rg -n "actor |TaskGroup|withTaskGroup|NSLock|Semaphore|cache|memo|atomic|diagnostics" ...
nl -ba <specific files> | sed -n '<ranges>'
```

Timings/checkpoints:

- `rg --files | wc -l`: 1,823 files, `real 0.02`.
- broad semantic `rg`: `real 0.04`, but produced 6,638 lines and was too noisy for direct synthesis.
- directory/source inventory: immediate enough to be useful, no measurable delay beyond shell startup.

## Files Inspected

- `rp-mini/AGENTS.md:1-49`
- `rp-mini/CONTINUITY.md:1-84`
- `rp-mini/MISTAKES.md:1-8`
- `repoprompt-ce/AGENTS.md:1-263`
- `repoprompt-ce/docs/architecture/source-layout.md:20-44`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPFileToolProvider.swift:18-25,78-168,171-262,265-369,372-754`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPSelectionToolProvider.swift:18-24,29-64,104-220`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPPromptContextToolProvider.swift:18-24,27-61,75-103`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPApplyEditsToolProvider.swift:25-75,78-232`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPGitToolProvider.swift:44-136,139-203,288-323,334-437,531-560`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPContextBuilderToolProvider.swift:6-24,109-163,166-231,274-470,474-509`
- `Sources/RepoPrompt/Features/ContextBuilder/ViewModels/ContextBuilderAgentViewModel.swift:97-180,383-395,1517-1695,2638-2689,3518-3563`
- `Sources/RepoPrompt/Features/ContextBuilder/ViewModels/ContextBuilderRunLifecycle.swift:35-142,144-195`
- `Sources/RepoPrompt/Features/AgentMode/Services/AgentProviderContextBuilder.swift:3-76`
- `Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt+Investigate.swift:14-41,79-86,241-268`
- `Sources/RepoPrompt/Infrastructure/WorkspaceContext/WorkspaceFileContextStore.swift:111-145,548-665,684-700,908-1008`
- `Sources/RepoPrompt/Infrastructure/WorkspaceContext/WorkspaceFileSystemIngressCoordinator.swift:3-8,74-88,114-160,228-293`
- `Sources/RepoPrompt/Features/Search/StoreBackedWorkspaceSearchLane.swift:42-68,158-250`
- `Sources/RepoPrompt/Features/Search/SearchMatch.swift:575-648,668-674,1372-1405,2336-2365`
- `Sources/RepoPrompt/Features/CodeMap/CodeMapGenerator.swift:14-23,171-240`
- `Sources/RepoPrompt/Features/CodeMap/CodeMapExtractor.swift:65-112,157-195,780-840`
- `Sources/RepoPrompt/Features/CodeMap/CodeMapCacheManager.swift:53-120,143-205,242-384`
- `Sources/RepoPrompt/Features/CodeMap/CodeScanActor.swift:15-41,127-143,187-224`
- `Sources/RepoPrompt/Infrastructure/MCP/ApplyEdits/ApplyEditsEngine.swift:3-20,31-87,89-163,315-375,514-545`
- `Sources/RepoPrompt/Infrastructure/VCS/VCSService.swift:21-29,46-57,125-164`
- `Sources/RepoPrompt/Infrastructure/VCS/GitBackend.swift:7-18,97-113,180-220`
- `Sources/RepoPrompt/Infrastructure/VCS/GitDiff/GitDiffEngine.swift:4-35,84-166`
- `Sources/RepoPrompt/Infrastructure/VCS/GitDiff/GitDiffSnapshotPublisher.swift:3-14,20-132`
- `Sources/RepoPrompt/Infrastructure/MCP/Agent/AgentRunMCPToolService.swift:141-237,239-377,379-430,650-760`
- `Sources/RepoPrompt/Infrastructure/MCP/Agent/AgentRunSessionStore.swift:3-15,59-75,76-90,92-135,150-220`
- `Sources/RepoPrompt/Infrastructure/MCP/Agent/AgentManageMCPToolService.swift:57-80,83-160,163-253`
- `Sources/RepoPrompt/Features/AgentMode/ViewModels/AgentModeViewModel.swift:3980-4068,5921-5960,13574-13592,14554-14585`

## Findings

### 1. CE has the same conceptual navigation surface as rp-mini, but it is app/window/tab scoped.

CE registers file/navigation tools through window-scoped providers. `MCPFileToolProvider.buildTools` returns `file_actions`, `get_code_structure`, `get_file_tree`, `read_file`, and `file_search` (`MCPFileToolProvider.swift:18-25`). The concrete schemas and behavior match rp-mini's target surface:

- `get_code_structure` supports explicit `paths` and `selected` scopes, line-numbered codemap output, max-result capping, and freshness drains before resolving files (`MCPFileToolProvider.swift:78-168`).
- `get_file_tree` supports `roots`, `files`, `auto`, `full`, `folders`, `selected`, `path`, and `max_depth`, with selected/codemap markers and worktree projection (`MCPFileToolProvider.swift:171-258`).
- `read_file` supports positive line ranges and negative tail reads, resolves worktree-projected paths, awaits explicit freshness, and auto-selects read files in a deferred queue (`MCPFileToolProvider.swift:265-369`; lower-level read path at `MCPServerViewModel.swift:3489-3566`).
- `file_search` supports auto/path/content/both, regex/literal behavior, filters, count-only, context lines, whole-word, and response capping near 50k chars (`MCPFileToolProvider.swift:372-754`).

Implication for rp-mini: preserve the API shape and error ergonomics, but simplify scope ownership. rp-mini should not inherit CE's dependency on macOS windows, active workspaces, compose tabs, and compatibility routing. Instead, keep explicit root/session state as the primary routing model.

### 2. Selection and workspace context are the core state model.

CE's `manage_selection` is not just a list setter. Its schema supports full files, slices, codemap-only entries, preview/promote/demote, fuzzy path resolution, auto-codemap behavior, strict mode, and several display views (`MCPSelectionToolProvider.swift:29-64`). The implementation drains pending auto-selection, resolves tab context, physicalizes/logicalizes worktree-bound selections, applies set/add/preview semantics, and assembles token-aware replies (`MCPSelectionToolProvider.swift:104-220`).

`workspace_context` is the canonical render/export snapshot. It defaults to prompt, selection, code, and tokens; optional includes add files/tree; export/list/select preset are routed through prompt export handling (`MCPPromptContextToolProvider.swift:22-103`). The DTO builder gathers selection collections, builds file blocks, codemap structure, selected tree, token stats, user-vs-normalized token deltas, and worktree scope (`MCPServerViewModel+WorkspaceContext.swift:5-246`).

Implication for rp-mini: preserve full/slices/codemap selection, token deltas, and a single workspace snapshot/export tool. Simplify copy-preset/UI compatibility paths unless plugin hosts need them.

### 3. CE's context builder is an orchestrated agent run, not a deterministic local analyzer.

The MCP `context_builder` tool advertises autonomous discovery, token-budgeted file selection, instruction rewriting, response types (`clarify`, `question`, `plan`, `review`), export-response handoff, and progress timing expectations (`MCPContextBuilderToolProvider.swift:109-145`). Execution resolves a target window/workspace/tab, binds caller context, starts an MCP-controlled Context Builder run, applies token budget and preferred agent/model overrides, and sends progress/heartbeat messages (`MCPContextBuilderToolProvider.swift:166-231,274-306,474-509`).

After the builder finishes, CE reads the final tab state, formats selection, optionally runs plan/question/review generation, and optionally writes an oracle export file (`MCPContextBuilderToolProvider.swift:315-470`). The VM entry point enforces one active run per tab, restores UI configuration after ephemeral overrides, and registers the run in a dedicated lifecycle registry (`ContextBuilderAgentViewModel.swift:1517-1695`; `ContextBuilderRunLifecycle.swift:144-195`).

The actual prompt sent to the builder contains current prompt content, custom Context Builder prompts, discover instructions, token budget, codemap compression guidance, and output-format instructions (`ContextBuilderAgentViewModel.swift:2638-2689`).

Implication for rp-mini: preserve Context Builder as a host/subagent prompt workflow backed by deterministic context tools. Do not try to port CE's full SwiftUI runtime. rp-mini's shared prompt/subagent approach is the right simplification.

### 4. CE seeds agent threads and forks with project tree and token-capped selected contents.

`AgentProviderContextBuilder.initialFileTree` builds a physicalized selection tree, logicalizes worktree projections, and renders it through `CodeMapExtractor.generateFileTree` (`AgentProviderContextBuilder.swift:3-27`). `forkFileContentsBlock` calculates selection token usage, returns a summary if over cap, or emits `<file_contents>` blocks with codemap snapshots and projected display paths (`AgentProviderContextBuilder.swift:29-76`). AgentMode uses those helpers in initial thread context and fork payload construction (`AgentModeViewModel.swift:13574-13592,14554-14585`).

Implication for rp-mini: preserve the two-level behavior: cheap initial tree for orientation, full selected content only when under cap, and summary fallback when over cap.

### 5. CE codemaps combine tree-sitter extraction, filesystem tree rendering, auto referenced APIs, and heavy cache machinery.

`CodeMapGenerator` is a SwiftTreeSitter-based generator with extensive perf counters and line caches (`CodeMapGenerator.swift:14-23,171-240`). `CodeMapExtractor` handles file-tree rendering, marker legends, token budgets, output caps, and auto referenced API inclusion from selected files to unselected files (`CodeMapExtractor.swift:65-112,157-195,780-840`). `CodeMapCacheManager` stores root-folder caches, validates modification date plus content fingerprint, purges stale versions, writes atomically, and hashes root paths for cache filenames (`CodeMapCacheManager.swift:53-120,143-205,242-384`).

`CodeScanActor` adds scan concurrency control, a single Tree-sitter parse limiter, result batching/coalescing, root-cache single-flight loads, actor-owned root caches, and dirty-root flushing (`CodeScanActor.swift:15-41,127-143,187-224`).

Implication for rp-mini: preserve content fingerprinting, atomic cache writes, lazy/single-flight cache loads, and codemap marker/tree behavior. Improve by making cache paths repo-local and host-agnostic rather than CE's Application Support location.

### 6. CE search has explicit performance/admission control.

Search is a store-backed actor. `FileSearchActor` defines regex safety caps, path/content batch sizes, max concurrent tasks, and an NSCache for line indexes (`SearchMatch.swift:575-648,668-674`). Content and path scans use `withThrowingTaskGroup`, bounded batch windows, ordered draining, early cancellation when caps are hit, and batched workers (`SearchMatch.swift:1372-1405,2336-2365`).

Broad unscoped content searches go through `StoreBackedWorkspaceSearchLane`, a per-workspace actor that allows one active broad search and one queued wait with bounded retry semantics (`StoreBackedWorkspaceSearchLane.swift:42-68,158-250`). `MCPFileToolProvider.executeFileSearch` maps lane admission failures to backpressure DTOs instead of generic crashes (`MCPFileToolProvider.swift:503-520`).

Implication for rp-mini: preserve broad-search backpressure and result caps. Improve over Bead 12's observed stdout maxBuffer anomaly by streaming/capping before collecting huge ripgrep output.

### 7. CE workspace freshness is driven by ordered ingress barriers.

`WorkspaceFileContextStore` is an actor holding root states, catalog/path maps, search snapshot caches, and ingress barrier flights (`WorkspaceFileContextStore.swift:111-145,633-665,684-700`). It applies filesystem deltas after filtering discoverable changes (`WorkspaceFileContextStore.swift:548-599`) and joins or launches scoped ingress barriers so callers wait only for the needed freshness target (`WorkspaceFileContextStore.swift:908-1008`).

`WorkspaceFileSystemIngressCoordinator` is a lock-backed, per-root serial queue. Publications are accepted before the Combine sink returns, then drained in order with waiters resumed after requested service-publication sequences are applied (`WorkspaceFileSystemIngressCoordinator.swift:3-8,74-88,114-160,228-293`).

Implication for rp-mini: preserve verify-on-read freshness and in-flight join semantics. Simplify live watcher complexity for MVP if rp-mini primarily rebuilds from mtime/catalog snapshots, but keep the no-stale-read contract.

### 8. CE apply_edits is layered and fail-closed.

The MCP tool exposes mutually exclusive rewrite/single/batch modes, requires a path, and marks the operation destructive (`MCPApplyEditsToolProvider.swift:25-75`). Execution builds a normalized request, resolves worktree and tab context, uses `WorkspaceFileEditHost`, optionally requests Agent Mode review approval, runs `ApplyEditsService`, flushes store deltas, and returns structured summaries (`MCPApplyEditsToolProvider.swift:78-232`).

The engine supports rewrite, single replacement, and batch edits; uses escape fallback; tries exact literal batch first; then diff generation; renders unified diffs; maps no-match and ambiguous-match errors to invalid params (`ApplyEditsEngine.swift:3-20,31-87,89-163,315-375,514-545`).

Implication for rp-mini: preserve the fail-closed ladder, ambiguity rejection, transactional batch semantics, and post-edit context refresh. Simplify user approval UI paths because rp-mini runs under host approval policy.

### 9. CE git surfaces are richer than rp-mini needs, but the safe read-only core is reusable.

The `git` MCP tool is read-only and supports status, diff, log, show, blame, compare specs, detail levels, artifacts, repo targeting, worktree warnings, and safe flags (`MCPGitToolProvider.swift:44-136`). Execution resolves repo roots from loaded workspace roots, detects worktrees, supports multi-root helpers, publishes diff artifacts, and can auto-select primary artifacts into context (`MCPGitToolProvider.swift:139-203,288-437`).

VCS routing is actor-backed and supports Git/Jujutsu detection with caches (`VCSService.swift:21-29,46-57,125-164`). Git diff snapshotting is actor-backed, stores repo-scoped snapshots, computes fingerprints, writes current snapshot IDs, and triggers retention maintenance (`GitDiffSnapshotPublisher.swift:3-14,20-132`). `GitDiffEngine` caches diff text by repo/target/scope/status/backend and builds summaries before optional diff text (`GitDiffEngine.swift:4-35,84-166`).

Implication for rp-mini: preserve safe git status/diff/log/show/blame with no-ext-diff/no-textconv/no-prompt behavior and artifact-style review exports. Simplify JJ/worktree merge/snapshot-retention unless they are explicit plugin requirements.

### 10. CE multi-agent control is a substantial session subsystem.

`agent_run` supports start/poll/wait/cancel/steer/respond and rejects unsupported operations (`AgentRunMCPToolService.swift:216-237`). Start resolves source tab, parent session, optional worktree request, default role label, model selection, session target, then starts the run or waits for an interesting state unless detached (`AgentRunMCPToolService.swift:239-377`). Wait supports single-session and multi-session wait/poll (`AgentRunMCPToolService.swift:379-430`) and blocks on `AgentRunSessionStore.waitUntilInteresting` with timeout, wake, terminal, superseded, and steering-interrupted outcomes (`AgentRunMCPToolService.swift:650-760`).

`AgentRunSessionStore` is an actor keyed by session ID/generation/epoch. It replaces stale registrations, tracks waiters, terminal snapshots, successor epochs, TTLs, and wake reasons (`AgentRunSessionStore.swift:3-15,59-90,92-135,150-220`). `agent_manage` lists role-label mappings and sessions, including persisted and live sessions, and scopes children when called from Agent Mode (`AgentManageMCPToolService.swift:57-80,83-160,163-253`).

Implication for rp-mini: do not port CE's agent control plane. rp-mini should expose context tools and packaged prompts; the host owns subagent lifecycle. Preserve only prompt contracts and export handoff patterns.

## Preserve / Simplify / Improve

Preserve:

- Tool names and core semantics: `file_search`, `read_file`, `get_file_tree`, `get_code_structure`, `manage_selection`, `workspace_context`, `prompt`, `apply_edits`, `file_actions`, `git`.
- Selection modes: full, slices, codemap-only, auto codemap dependencies, token accounting, and selected tree/code structure.
- Context Builder prompt shape: task/context/discovery hints, token budget, codemap compression guidance, response types, export handoff.
- Safety: path resolution errors with actionable workspace messages, destructive annotations or equivalent host metadata, git safe flags, apply-edits ambiguity rejection.
- Performance controls: codemap cache freshness, single-flight loads, search caps/backpressure, result capping before response assembly, ingress freshness joins.

Simplify:

- Remove CE's SwiftUI/window/compose-tab compatibility layer from rp-mini. Use explicit root/session IDs.
- Replace CE's app-managed workspace/root store with a repo-local catalog plus verify-on-read freshness.
- Keep Context Builder as host agent/subagent prompts. Do not embed agent runtime, model catalog, UI logs, or Agent Mode session storage in rp-mini.
- Keep git read-only core and review artifacts; skip CE's worktree merge management, JJ preference, and snapshot retention unless later requirements demand them.
- Keep apply_edits engine semantics; skip interactive approval UI and let the host approval system govern writes.

Improve:

- Stream ripgrep output or cap before buffering to avoid broad-query stdout `maxBuffer` failures noted in rp-mini Bead 12.
- Make cache location deterministic and repo-local (`.rp-mini`) with atomic writes and content-hash/mtime validation, not CE's Application Support cache.
- Publish machine-readable receipts for exports/benchmarks from the start; CE has rich internal diagnostics but they are app/debug oriented.
- Keep schemas narrower and lower ceremony than CE while retaining line-numbered evidence and worktree/session path projection where needed.
- Add benchmark tests specifically for broad search, codemap cold/warm paths, and four concurrent context sessions, since CE's protections are spread across many actors.

## Unknowns / Gaps

- I did not run CE, its MCP CLI, tests, or apps by instruction. Runtime behavior is inferred from source.
- I did not inspect every provider/runtime file under `AgentMode`; the core MCP session store and control surfaces were enough for this question.
- I did not verify historical intent through PRs beyond `git log --oneline -5`; line evidence is code-shape evidence, not maintainer rationale.
- The broad `rg` output was truncated by the harness, so I switched to targeted searches and file reads. The report should be judged on cited line evidence, not exhaustive grep coverage.

## Tool Friction

- Shell-only investigation was fast for locating files (`rg --files` in 0.02s), but broad semantic grep was noisy: 6,638 result lines in 0.04s, many from tests/docs/transcript UI.
- Without RepoPrompt codemaps, large Swift files required manual line-range slicing. This was manageable but easy to under-sample.
- One guessed file path (`GitDiffSnapshotService.swift`) did not exist; `find Sources/RepoPrompt/Infrastructure/VCS -type f` corrected the inventory.
- Maintaining precise line evidence manually took most of the time, not command execution.

## Quality Self-Score

Score: 8/10.

Rationale: the report covers the requested surfaces with concrete file:line evidence and clear preserve/simplify/improve recommendations. It is credible for architecture benchmarking. It loses points because shell-only constraints limited depth in very large files, I did not run live CE behavior, and the multi-agent/runtime surface is broad enough that a full audit would need another pass over provider-specific runners and tests.
