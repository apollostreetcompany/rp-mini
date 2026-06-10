# Bead 13 Agent 02 - Normal RepoPrompt Investigation

## Run Metadata

- agent: subagent 2
- route under test: normal RepoPrompt MCP/CLI, not rp-mini
- start_utc: 2026-06-10T06:43:51Z
- end_utc: 2026-06-10T06:54:29Z
- wall_clock_seconds: 638
- output_path: `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/handoff/bead-13/agents/02-repoprompt-investigate.md`
- write scope honored: only this report path was written

## Tool Timings and Route Notes

Normal RepoPrompt MCP was available after tool discovery, but initial routing failed because multiple RepoPrompt windows were open. Binding by workspace roots fixed it.

Measured checkpoints:

| checkpoint | tool/command | timing |
| --- | --- | --- |
| run start | `date -u +%Y-%m-%dT%H:%M:%SZ` | 2026-06-10T06:43:51Z |
| CE CLI probe | `command -v rpce-cli-debug`; direct fallback path probe | <1s; not found |
| first roots call | `mcp__repoprompt.get_file_tree {"type":"roots"}` | 0.0049s; returned bind-context warning |
| bind | `mcp__repoprompt.bind_context` with rp-mini + repoprompt-ce roots | 0.0303s |
| roots after bind | `mcp__repoprompt.get_file_tree {"type":"roots"}` | 0.0178s |
| CE folder tree | `mcp__repoprompt.get_file_tree` on CE, folders depth 3 | 0.0408s |
| context builder | `mcp__repoprompt.context_builder` with `response_type:"question"` | 447.7137s |
| broad codemap | `mcp__repoprompt.get_code_structure` on five CE areas | 0.1101s; 8 codemaps shown, 109 omitted |
| content search fallback | shell `rg -n "context_builder|workspace_context|..."` | <1s; used because RepoPrompt `file_search` was not exposed |
| targeted reads | shell `nl -ba ... | sed -n ...` | <1s each; used for stable line refs |

Tool friction:

- `rpce-cli-debug` was not on PATH, and the direct CE debug CLI path from CE `AGENTS.md` was not executable/present.
- Normal RepoPrompt MCP required explicit binding because multiple windows were open.
- `file_search` and `git` were advertised by RepoPrompt MCP metadata but were not callable in the exposed Codex tool namespace during this run. I used shell `rg` for search and did not run RepoPrompt git.
- The context builder gave a high-quality curated map, but 447.7s is a real benchmark cost for this route.

## Files Inspected

Required pre-read files:

- `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/AGENTS.md`
- `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/CONTINUITY.md`
- `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini/MISTAKES.md`
- `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce/AGENTS.md`

CE implementation evidence:

- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPWindowToolNames.swift:3-35`
- `Sources/RepoPromptMCP/CommandRunner/ToolGroups.swift:45-99`
- `Sources/RepoPrompt/Infrastructure/AI/SystemPromptService.swift:272-435`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPContextBuilderToolProvider.swift:109-180`, `300-470`
- `Sources/RepoPrompt/Features/ContextBuilder/ViewModels/ContextBuilderAgentViewModel.swift:1423-1648`, `2511-2648`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPFileToolProvider.swift:18-180`, `220-560`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPSelectionToolProvider.swift:60-230`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPPromptContextToolProvider.swift:35-220`
- `Sources/RepoPrompt/Features/CodeMap/CodeMapExtractor.swift:65-120`, `546-620`, `780-870`
- `Sources/RepoPrompt/Features/Search/StoreBackedWorkspaceSearchLane.swift:1-220`
- `Sources/RepoPrompt/Infrastructure/WorkspaceContext/Search/WorkspaceSearchService.swift:1-220`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPApplyEditsToolProvider.swift:40-220`
- `Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPGitToolProvider.swift:35-180`
- `Sources/RepoPrompt/Features/AgentMode/Runtime/AgentModeRunService.swift:155-250`, `313-374`
- `Tests/RepoPromptTests/MCP/Control/PersistentMCPDistinctConnectionConcurrencyTests.swift:225-303`
- `Tests/RepoPromptTests/MCP/TabContextRoutingTests.swift:226-286`

## Findings

### 1. CE context discovery is both a prompt contract and an app-controlled run

The user-facing MCP surface is `context_builder`. It is registered in `MCPContextBuilderToolProvider`, with `instructions`, `response_type`, and `export_response` inputs; response types include clarify, question, plan, and review (`MCPContextBuilderToolProvider.swift:109-154`). The provider drains pending read-file auto-selection, parses response type, then runs a controlled Context Builder lifecycle (`MCPContextBuilderToolProvider.swift:166-180`).

The provider then collects final tab state, computes selection/file counts and tokens, optionally generates a plan/question/review follow-up, emits stage progress, and can export generated output (`MCPContextBuilderToolProvider.swift:300-470`). The heavy implementation lives in `ContextBuilderAgentViewModel`: it resolves discovery vs response budgets (`1423-1430`), runs MCP-controlled discovery with ownership checks and ephemeral setting overrides (`1517-1648`), and constructs the agent message from budget, response type, file tree, current prompt, and discover instructions (`2511-2648`).

The strongest portable lesson is in the discover prompt itself: CE tells the builder to explore with `get_code_structure`, `file_search`, `read_file`, build selection iteratively, and verify tokens with `workspace_context` before stopping (`SystemPromptService.swift:347-435`). It also states "The Selection Is The Universe" (`SystemPromptService.swift:431-435`), which rp-mini should preserve exactly as a product principle.

### 2. CE MCP navigation surfaces are providerized around stable tool names

CE centralizes stable tool names in `MCPWindowToolNames.swift`, including `manage_selection`, `file_actions`, `get_code_structure`, `get_file_tree`, `read_file`, `file_search`, `workspace_context`, `prompt`, `apply_edits`, `git`, and `context_builder` (`MCPWindowToolNames.swift:3-35`). The CLI groups them into binding, context, explore, git, edit, conversation, and settings (`ToolGroups.swift:45-99`).

`MCPFileToolProvider` owns the core navigation tools: `file_actions`, `get_code_structure`, `get_file_tree`, `read_file`, and `file_search` (`MCPFileToolProvider.swift:18-25`). It waits for applied ingress before code structure and tree reads (`MCPFileToolProvider.swift:117-124`, `243-250`), supports read ranges and auto-selection after reads (`304-369`), and implements rich search options with mode, regex, filters, max results, context lines, count-only, and worktree projection (`372-560`).

Selection is a first-class state machine. `MCPSelectionToolProvider` exposes `get`, `add`, `remove`, `set`, `clear`, `preview`, `promote`, and `demote`, with `full`, `slices`, and `codemap_only` modes (`MCPSelectionToolProvider.swift:60-99`). It drains read-file auto-selection, resolves tab context, physicalizes projected paths, and persists selection mutations (`104-230`).

`workspace_context` and `prompt` are paired in `MCPPromptContextToolProvider`: snapshot includes `prompt`, `selection`, `code`, `files`, `tree`, and `tokens`, while export/list/select preset behavior routes through the prompt path (`MCPPromptContextToolProvider.swift:35-103`). Prompt mutation/export is tab-aware and blocks preset selection without explicit binding in run contexts (`150-220`).

### 3. CE codemaps provide tree markers, definition blocks, and auto references

`CodeMapExtractor` is a compact ancestor for rp-mini's codemap behavior. It generates file trees from a selection context (`CodeMapExtractor.swift:65-88`), defines bad extensions/directories and token budgets for auto/MCP tree output (`95-110`), builds local definition blocks for auto/complete/selected codemap usage (`546-620`), and computes auto-referenced FileAPIs by mapping referenced type names to unselected definitions (`780-870`).

This evidence supports rp-mini preserving FileAPI-like codemap output and auto-codemap dependencies, while simplifying the implementation to a tree-sitter-backed TypeScript serializer and capped per-file output.

### 4. CE performance/concurrency is protective because the app is shared

CE uses multiple concurrency layers rather than a single queue. Broad unscoped content search is guarded by an actor lane with one active permit and one queued waiter; excess callers receive backpressure with retry guidance (`StoreBackedWorkspaceSearchLane.swift:42-68`, `158-220`). The distinct-connection concurrency test asserts exactly that: 12 endpoints produce 1 active, 1 waiting, and the rest backpressured, then all can retry successfully (`PersistentMCPDistinctConnectionConcurrencyTests.swift:225-303`).

Path search is also actor-owned and keeps indexes off the main actor. `WorkspaceSearchService` tracks applied-index events, pending/active rebuild generations, stale state, and indexed generation metadata (`WorkspaceSearchService.swift:1-88`, `114-220`).

Agent runtime orchestration is provider-specific. `AgentModeRunService.startRun` dispatches Codex, Claude-native, ACP, or headless runners and constructs MCP bootstrap leases for agent-mode policy installation (`AgentModeRunService.swift:155-250`). Steering uses a guarded flush task and re-enters if new queued instructions arrive (`AgentModeRunService.swift:313-374`). Tab-context routing tests show CE has substantial compatibility logic around `bind_context`, `workspace_context`, `manage_selection`, `read_file`, `file_search`, and `context_builder` (`TabContextRoutingTests.swift:226-286`).

For rp-mini, most of this is evidence to simplify: per-session MCP stdio processes and per-session selection can avoid CE's window/tab/run compatibility matrix. Preserve the invariants, not the GUI runtime.

### 5. Edits and git are mature but should be scoped carefully

`apply_edits` exposes rewrite, single replacement, and multi-edit modes, with diff preview and review/approval handling for agent-mode runs (`MCPApplyEditsToolProvider.swift:40-220`). The provider says failed matches may retry with escape decoding (`40-45`), but the selected evidence does not show the full matching ladder. Treat apply-edits internals as a follow-up verification area before claiming parity.

`git` is explicitly safe/read-only. It supports `status`, `diff`, `log`, `show`, and `blame`, rich compare specs, artifact publishing for review, multi-repo targeting, and safe flags such as `--no-ext-diff`, `--no-textconv`, `--color=never`, and `GIT_TERMINAL_PROMPT=0` (`MCPGitToolProvider.swift:44-103`). rp-mini should preserve the safe read-only framing and structured diff artifacts.

## Preserve / Simplify / Improve for rp-mini

Preserve:

- Context Builder's contract: describe the task, explore broadly, select files, rewrite/clarify the prompt, and verify tokens before stopping.
- The 10-tool core surface: tree, search, read, codemaps, selection, workspace context, prompt, apply edits, file actions, git.
- Selection modes and operations: full, slices, codemap-only, promote/demote, preview, strict invalid-path reporting.
- Codemap auto-reference behavior from selected files to referenced type definitions.
- Backpressure as an explicit response with retry guidance rather than hangs or silent truncation.
- Read-only git safety flags and review artifact generation.

Simplify:

- Do not port CE's window/tab routing, legacy binding compatibility, or GUI freshness barriers as core abstractions.
- Do not make rp-mini own provider runtimes, steering queues, oracle chats, or agent-run lifecycle.
- Keep context-builder as host subagent prompt/config plus stateful MCP context engine, not as a server-side app-controlled run.
- Use per-session state and process isolation instead of shared app-level policy/routing where possible.

Improve:

- Make benchmarkable wall-clock targets part of the API contract. Normal RepoPrompt context_builder took 447.7s here, useful but slow.
- Stream/cap search before subprocess stdout buffers grow too large; Bead 12 already found broad `import` searches can overflow rp-mini's current Node `execFile` buffer.
- Emit deterministic export receipts with content hash, token breakdown, selected modes, preset, and git state.
- Keep codemap output capped per file and skip generated/minified content, while not gating large source files purely by size.
- Make CLI/noninteractive install friction visible; CE's debug CLI was not reachable here despite being the preferred AGENTS route.

## Unknowns

- Full `WorkspaceFileContextStore` internals were not inspected; I only verified callers, search service, and selection/token-adjacent surfaces.
- Full `ApplyEditsService` / engine internals were not inspected; provider-level behavior is verified, matching ladder details are not.
- Full `GitDiffSnapshotStore` artifact layout was not inspected.
- Exact tree-sitter query/language coverage in CE codemap internals was not inspected.
- Normal RepoPrompt `file_search` and `git` MCP tools were advertised but unavailable as callable Codex tools in this run, so their live MCP behavior was not timed.

## Commands / Queries Used

Pre-read:

```bash
sed -n '1,220p' AGENTS.md
sed -n '1,240p' CONTINUITY.md
sed -n '1,220p' MISTAKES.md
sed -n '1,260p' ../repoprompt-ce/AGENTS.md
```

Tool route probes:

```bash
command -v rpce-cli-debug || true
test -x "$HOME/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli_debug" && printf '%s\n' "$HOME/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli_debug" || true
```

Normal RepoPrompt MCP:

```json
{"tool":"bind_context","args":{"op":"bind","working_dirs":"/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini,/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce"}}
{"tool":"get_file_tree","args":{"type":"roots"}}
{"tool":"get_file_tree","args":{"type":"files","path":"/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce","mode":"folders","max_depth":3}}
{"tool":"context_builder","args":{"response_type":"question","instructions":"Investigate RepoPrompt CE as rp-mini's ancestor..."}}
{"tool":"get_code_structure","args":{"paths":[".../WindowTools",".../ContextBuilder",".../Search",".../WorkspaceContext",".../AgentMode/Runtime"],"max_results":30}}
```

Fallback/search/read commands:

```bash
rg -n "context_builder|workspace_context|manage_selection|file_search|apply_edits|MCPWindowToolNames|StoreBackedWorkspaceSearchLane|AgentRunTerminalCommitBarrier" Sources/RepoPrompt Sources/RepoPromptMCP Sources/RepoPromptShared Tests/RepoPromptTests -g '*.swift'
nl -ba <file> | sed -n '<start>,<end>p'
```

## Quality Self-Score

Score: 8/10.

Rationale: The report uses normal RepoPrompt MCP for the core benchmark route, includes measured timings, and verifies the generated context-builder map with direct file:line evidence. It loses points because `file_search` and `git` were not callable through the exposed MCP namespace, CE CLI was unavailable noninteractively, and I did not inspect the full edit engine/store/artifact internals. For a read-only benchmark subagent, the evidence is strong enough to compare route quality and guide rp-mini preservation/simplification work.
