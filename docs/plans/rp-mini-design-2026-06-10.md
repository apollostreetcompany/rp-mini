# rp-mini — Minimal RepoPrompt as a Configurable Plugin

**Date:** 2026-06-10 · **Status:** Draft for approval · **Working name:** `rp-mini` (alternatives: `repokit`, `ctxsmith`)

A headless reimplementation of RepoPrompt CE's context engine as a TypeScript MCP server, packaged for Claude Code (plugin: skills + subagent + MCP) and Codex (config + skills). Copies the six proven assets, cuts the macOS app, provider plumbing, and orchestration layer that modern harnesses now provide natively.

Source of truth analyzed: `repoprompt-ce` @ github.com/repoprompt/repoprompt-ce (Apache 2.0 — port freely with attribution in THIRD_PARTY_NOTICES).

---

## 1. Thesis

RepoPrompt's value is **context infrastructure**, not orchestration:

| Asset (copy) | Where it lives in CE | Port cost |
|---|---|---|
| Context Builder discovery contract (prompt + budget ladder + handoff format) | `SystemPromptService.swift:25-575`, `ContextBuilderDefaults.swift` | ~200-line prompt, ships as harness subagent/skill |
| CodeMaps (tree-sitter signature extraction, 14 langs, sha256+mtime cache) | `Features/CodeMap/`, `Infrastructure/SyntaxParsing/Queries/` | ~2k LOC |
| Selection state machine (full / slices / codemap_only + auto-codemap deps + token accounting) | `StoredSelection`, `PartitionStore`, `PromptContextAccountingService` | ~800 LOC |
| Packaged prompt format (`<file_map>` → `<file_contents>` → `<git_diff>` → meta → `<user_instructions>`) | `PromptPackagingService.swift:436-543` | ~300 LOC |
| apply_edits matching ladder (literal → escape-decode → Dice fuzzy → ambiguity-throw; batch line-delta tracking; indent re-anchor) | `ApplyEditsEngine.swift`, `DiffGenerationUtility.swift:1242-1509` | ~500 LOC |
| Token-capped tool discipline (caps + `limit_hit` + omission counts + refinement suggestions on every tool) | per-tool providers under `Infrastructure/MCP/` | design convention, ~free |

**Cut:** macOS UI, provider plugin seam (claude/codex/cursor/GLM bridges), agent session/worktree/resume management, oracle chat infra, bind_context/windows/tabs, Unix-socket transport, Sparkle/diagnostics/benchmarks, developer daemon.

**Replace:** in-process PCRE2 search → **ripgrep subprocess**; FSEvents ingress coordination → **chokidar + on-demand revalidation**; bytes/4 tokenizer → kept as fast default, **pluggable tiktoken** for accuracy; server-side context_builder agent → **host-harness subagent** using rp-mini's MCP tools.

The single biggest simplification: **intelligence runs on the host harness; rp-mini is the stateful context engine.** CE spends most of its code owning model processes; we own none.

## 2. Architecture

```
rp-mini/  (monorepo, pnpm + TypeScript, MIT or Apache-2.0)
  packages/
    core/                 # pure library, no MCP dependency
      src/
        catalog/          # file catalog: walk, ignore (.gitignore/.repo_ignore/.cursorignore +
                          #   hardcoded universal list), 10MB size cap, binary sniff,
                          #   chokidar watch w/ lazy revalidation (mtime check on read)
        codemaps/         # tree-sitter extraction → FileAPI model → text serializer;
                          #   per-lang .scm queries; cache: sha256+mtime JSON per root
        tokens/           # estimate(text) = utf8Bytes/4 * 1.05 (default);
                          #   optional tiktoken adapter; per-file cache keyed on sha
        selection/        # context cart: entries {path, mode: full|slices|codemap, ranges[]},
                          #   auto-codemap deps via referencedTypes, slice coalesce/subtract math,
                          #   persisted JSON at .rp-mini/selection.json (workspace-local, gitignored)
        search/           # ripgrep bridge (json output), modes auto/path/content/both,
                          #   fuzzy path scorer (bigram dice), char/result caps, limit_hit reporting
        edits/            # apply_edits ladder + multi-edit batch with cumulative line-delta
                          #   tracking + indentation re-anchoring
        packager/         # context payload assembly (XML sections, slice labels, lang fences)
        gitx/             # git subprocess: status/diff/log/show/blame, compare specs,
                          #   structured hunks, patch truncation (~300 lines @ detail=patches)
        config/           # config load/merge: defaults ← rp-mini.config.json ← env ← per-call args
    server/               # MCP stdio server (@modelcontextprotocol/sdk); tool defs + schemas;
                          #   one workspace per process (roots from --root flags or cwd)
    cc-plugin/            # Claude Code plugin: .claude-plugin/plugin.json, .mcp.json,
                          #   agents/context-builder.md, skills/rp-*/SKILL.md
    codex-plugin/         # Codex packaging: mcp_servers TOML snippet, ~/.codex/skills installers,
                          #   AGENTS.md usage snippet  (same skill markdown sources as cc-plugin)
  shared-prompts/         # single-source workflow + agent prompts, rendered into both plugins
```

Distribution: `npx rp-mini serve` (server), `claude plugin install` (CC), install script for Codex. Native `node-tree-sitter` grammars with WASM (`web-tree-sitter`) fallback so npx works without a compiler toolchain.

## 2.5 Concurrency & performance model

CE's multi-agent hangs are structural: one GUI app process serves all clients, MCP calls block on an FSEvents ingress barrier (`awaitAppliedIngress`), broad searches funnel through a **single-lease admission lane** (others queue → `search_backpressure`), all codemap parsing serializes through a **global tree-sitter lock (capacity = 1)**, and tool execution hops through the main actor. Bulk FS changes (a git checkout) stall every client's barrier at once. CE also does NOT eagerly index codemaps — only the file catalog builds at workspace-open; codemaps are lazy per-file with a disk cache (background scanner, 4–6 concurrent, batched flushes).

rp-mini removes every one of these choke points by construction:

| CE mechanism | rp-mini replacement |
|---|---|
| One app process, N clients | **One stdio server process per agent session** — zero cross-agent contention; OS scheduler does the isolation |
| FSEvents ingress barrier before reads/searches | **Verify-on-read**: stat/mtime check per file access (µs); ripgrep reads the live FS — always fresh, never blocks |
| Indexed in-process search + admission lane | **ripgrep** — index-free, per-call subprocess, bounded by `caps.search_chars`; per-process semaphore (default 4) only to bound memory |
| Global tree-sitter parse lock | Per-process worker pool (default `min(4, cores/2)`) — the global lock was GUI memory protection, unnecessary headless |
| App-lifetime in-memory catalog | Lazy catalog walk on first call (~100ms–1s typical), cached in-process; chokidar watch optional |
| Codemap disk cache (per-app) | **Shared cross-process disk cache** keyed sha256+mtime; atomic temp-file+rename writes, lock-free reads — N concurrent sessions share warm cache safely |
| UI "index on workspace open" | `rp-mini index [path]` CLI warm command + optional CC `SessionStart` hook that warms catalog+codemaps in background. Warming is an optimization, never a correctness requirement — no call ever waits on it |

Multi-agent selection state: the context cart is **per-session by default** (each agent process gets `.rp-mini/sessions/<session>.json`) so concurrent agents never fight over one selection; named profiles (`manage_selection op=save_profile/load_profile name=…`) enable deliberate cross-agent handoff.

## 2.6 Performance optimizations (adversarial review round)

Five additive wins, none changing the architecture:

1. **Token delta-accounting** (bead 5) — CE recomputes all entry token counts on every selection change (`TokenCalculationService:245-297`). rp-mini caches per-entry counts `{full, codemap, per-slice}` and updates the total by arithmetic delta.
2. **Lazy codemaps + type index** (bead 4) — REVISED per user review: big source files are where codemaps matter MOST ("know where things are"), so they are **always codemapped** — the parse cost is paid once per content change (sha+mtime cache). What gets gated: (a) pathological/generated content only (minified detection via avg line length, `.min.*`, lockfiles, vendored/generated globs) gets neither content nor codemap by default; (b) the codemap **output** per file is capped (~2k tokens, member lists truncated with `… (+N more)`) so a 30k-line god-file can't flood the structure view. Dependency resolution via a precomputed `definedTypeName → defining file` map built at cache-load time (O(1) lookup vs CE's O(n) name scan per file).
3. **Search relevance ranking** (bead 3) — post-ripgrep re-rank: path proximity to current selection + git-recency (one `git log --name-only` cached at index time) + symbol-definition boost from the codemap index. Better results, near-zero cost.
4. **Content-hashed snapshots** (bead 6) — sort files by path within every section, expose `content_hash` on `workspace_context export` so clients can dedupe and downstream prompt caches hit.
5. **Lazy grammar loading + keep-alive daemon** (beads 2/10) — load tree-sitter grammars per language on first use. The `--keep-alive` daemon ships (user-approved: lives on long-running headless machines) with **OOM protection as a requirement, not an option**: all in-memory caches are bounded LRU (decoded content, codemap objects, catalog snapshots); an RSS watchdog (default cap 1.5GB, configurable) evicts caches when exceeded and gracefully restarts the daemon if still over after GC (the stdio shim transparently respawns/reconnects); idle-timeout shutdown (default 5 min) plus optional max-lifetime. Default remains per-session stdio.

Token heuristic refinement (small, bead 5): keep bytes/4 default, add CJK upweight and minified-code downweight heuristics; tiktoken remains the opt-in accurate path.

## 3. MCP tool surface (10 tools)

Every tool response includes, when relevant: `limit_hit`, `omitted_*` counts, and a one-line refinement `suggestion`. All caps configurable.

| Tool | Spec (defaults) |
|---|---|
| `file_search` | pattern, mode auto/path/content/both, regex, filters, context_lines, max_results 50, ~50k-char response cap. ripgrep backend; path mode uses fuzzy bigram scoring. |
| `read_file` | path, start_line (negative = tail), limit. Returns content + total_lines + range echo. |
| `get_file_tree` | mode auto/full/folders/selected, max_depth, path. Auto-trims depth to ~10k-token target. Markers: `*` selected, `+` codemap available. |
| `get_code_structure` | paths or scope=selected, max_results 10, ~6k-token cap. Returns CodeMap text per file. |
| `manage_selection` | op get/add/remove/set/clear/promote/demote, mode full/slices/codemap_only, slices[{path, ranges, description}], view summary/files/content/codemaps. Auto-adds dependency codemaps (toggleable). Persists across calls/sessions. |
| `workspace_context` | op snapshot/export, include[prompt/selection/code/files/tree/tokens]. Token breakdown per section — the budget-check primitive for the context-builder agent. |
| `prompt` | op get/set/append/clear. Stores the curated handoff instructions alongside the selection. |
| `apply_edits` | path + (search/replace | edits[] | rewrite). Ladder: literal → escape-decode → fuzzy (Dice, length-adaptive thresholds 0.25–0.80) → throw on ambiguity with line numbers of candidates. Batch edits use cumulative line-delta adjustment. Indent re-anchor on replace. |
| `file_actions` | create/delete/move with if_exists guard. Configurable off. |
| `git` | op status/diff/log/show/blame; compare uncommitted/staged/unstaged/back:N/main/mergebase:X/revspec; detail summary/files/patches/full. Structured hunks `{header, oldStart, newStart, patch}`. Safety flags (`--no-ext-diff --no-textconv --color=never`, `GIT_TERMINAL_PROMPT=0`). |

### Full disposition of CE's 26 registered tool names

CE registers 23 window-scoped + 3 global tool names (`MCPWindowToolNames.swift`, `MCPGlobalToolNames.swift`); 6 are policy-gated (hidden from normal connections). The settings UI advertises the remainder (~17–19 depending on version/policy).

| Disposition | Tools | Where it goes |
|---|---|---|
| **Kept as rp-mini tools (10)** | `file_search`, `read_file`, `get_file_tree`, `get_code_structure`, `manage_selection`, `workspace_context`, `prompt`, `apply_edits`, `file_actions`, `git` | rp-mini MCP server |
| **Re-homed to host harness (8)** | `context_builder` → plugin **subagent**; `agent_explore`/`agent_run`/`agent_manage` → host subagents (Task tool / Codex spawn); `ask_oracle`/`oracle_send`/`oracle_chat_log`/`oracle_utils` → host model calls + `workspace_context op=export` files | cc-plugin / codex-plugin prompts |
| **Dissolved by design (8)** | `bind_context` + `manage_workspaces` → one workspace per server process (roots via config/args); `manage_worktree` → host worktrees; `app_settings` → config file; `ask_user` → host AskUserQuestion at the skill level (clarify-first, before spawning the subagent); `share_thoughts`/`set_status`/`wait_for_next_user_instruction` → host-native progress UX | n/a |

## 4. The context-builder agent (the crown jewel, re-homed)

Ships as `agents/context-builder.md` (Claude Code subagent, tools restricted to rp-mini MCP + read-only) and as a Codex skill. Distilled from CE's discover prompt; keeps verbatim the parts that do the work:

- **Mission:** "Curate the perfect file selection and craft a precise prompt for the next model. Do not implement."
- **"The selection is the universe"** framing — the next model may have no tools; when in doubt, include.
- **Budget:** hard (caller-specified) vs soft (target 50–80k, exceed for completeness). Defaults: 160k discovery / 120k when a plan response is requested. Budget counts files + codemaps + prompt + tree + diff.
- **Degradation ladder:** all relevant files **full** by default → prune irrelevant auto-codemaps → slice large files only under budget pressure → drop peripheral files last. Invariant: `full+slice tokens ≥ codemap tokens`. Files likely to be **edited** must be full/sliced, never codemap-only.
- **Mandatory pre-halt checklist + final gate:** verify token count via `workspace_context include=[tokens]`; do not halt over budget.
- **Handoff format** written via `prompt op=set`:
  `<taskname="…"/>` + `<task>` `<architecture>` `<selected_context>` `<relationships>` `<ambiguities>`
- **Review mode:** pull `git diff` artifacts into selection, interleave changed sources with affected-but-unchanged context.
- **Response types:** plan / question / review / clarify — same flow, different follow-up instruction; the *host* runs any follow-up reasoning in-context (no oracle needed).
- **Prompt enhancement modes** (ported verbatim from CE — "the model prompts the model"): `rewrite` (default — agent replaces the prompt via `prompt op=set` with the taskname + structured handoff), `augment` (agent appends `<discovered_architecture>` via `op=append`, original prompt untouched), `preserve` (agent never touches the prompt — selection-only curation). Config default + per-invocation parameter.
- **Automatic intent detection** (ported from `SystemPromptService.swift:1061-1106` as a pure function): explicit `response_type=review` OR phrase hotwords ("code review", "review the diff", "review this pr", "compare main", …) OR token fallback (`git` + `diff`/`diffs` both present) → activates review-mode guidance (pull diff artifacts + affected sources into selection). Same mechanism selects the export preset.
- **Clarifying questions, re-homed:** CE's `ask_user` + question-timeout setting existed because the builder ran in a GUI. In rp-mini the *skill* grills the user first (host AskUserQuestion) before spawning the context-builder subagent; the subagent itself runs uninterrupted. No timeout setting needed.

### The headless builder (REVISED 2026-06-10: Codex has native subagents)

Correction from user review: **Codex supports native subagents** (developers.openai.com/codex/subagents); CE's `multiAgentEnabled: false` was CE's provider-integration choice, not a platform limit.

- **Primary path on Claude Code AND Codex: native subagents.** The context-builder ships as a CC agent definition and a Codex subagent config, both rendered from the same shared discovery-prompt module.
- **`rp-mini build-context`** (headless CLI worker, ~300–500 LOC) is demoted to an **optional fallback**, deferred post-MVP: for hosts without subagent support and for CI/headless pipeline use. The shared prompt module keeps it cheap to add later.
- A full `agent_run` port (sessions, steering, worktrees, ~1200+ LOC) remains **explicitly deferred**.

**Intent presets** (CE's Standard/Plan/Diff Follow-Up/Review/Manual, ported as config profiles): each preset is `{include_files, include_tree, tree_mode, codemap_usage, git_inclusion, meta_prompts[]}` — selected explicitly (`workspace_context op=export preset=review`), by skill (each `rp-*` skill maps to one), or by the intent detector above. Built-ins: `standard`, `plan` (+Architect meta prompt), `review` (+Review meta prompt, git=selected), `diff-followup` (git only, no files/tree); users add custom presets in config. CE's XML Edit / XML Pro Edit modes are already deprecated upstream (legacy presets auto-downgrade; `apply_edits` superseded them) — not ported.

Skills (single-sourced in `shared-prompts/`, installed to both hosts): `rp-build`, `rp-investigate`, `rp-review`, `rp-refactor`, `rp-plan` (CE's deepPlan), `rp-export` (write packaged context to a file for any external model — replaces oracle export). Each is a thin workflow wrapper: scan → context-builder (native subagent on CC, `rp-mini build-context` elsewhere) → act on the handoff.

### Skills-library integration (user's vetted library)

- **Receipts**: `rp-export` emits a structured JSON receipt alongside the packaged context (task, selected files + modes, token breakdown, budget, preset, git state, content_hash) aligned with the library's `operator-contracts-and-receipts` format — rp-mini owns the *technical* receipt fields, operator-contracts owns approval/rollback fields.
- **proconsult compatibility**: the library's `proconsult-improve` skill assumes CE's `bind_context` window model; rp-mini's exports are file-based, so the consultation path becomes `rp-export` → proconsult consumes the file. `how` and `proconsult` work with rp-mini as-is. Boundary: rp-mini never re-implements external-model routing (proconsult owns it) or market research (market-intel MCP owns it).
- **Extra preset**: `mvp` (routes/entrypoints + build config + manifests focus, from the library's mvp-scoper methodology).
- **Back-ports to the library** (library-side work, not rp-mini beads): the `<task>/<architecture>/<selected_context>/<relationships>/<ambiguities>` handoff format, token-budget contract fields, and the intent-detector as a reusable primitive.

## 4.5 iOS & UI work (adversarial review round)

CE's Swift codemap is structural only — property wrappers (`@State`/`@Binding`/`@Observable`), `var body: some View`, and `#Preview` blocks are not distinguished (SwiftQueries.swift captures attributes generically), and there is no Xcode-artifact handling at all (ignore rules are just `.git`/`.svn`/`.DS_Store`). Verdict: targeted enhancements, no redesign; rp-mini stays **orthogonal** to Xcode MCP and Figma MCP — the skills layer orchestrates peers, the engine never calls other MCPs.

- **Tier 1.5 (post-MVP, cheap):** iOS-aware ignore preset auto-applied when `.xcodeproj` detected (skip pbxproj internals, Info.plist, storyboard/xib by default); `Package.swift` dependency surface extraction (products/targets/dependencies); optional `metadata` block in `workspace_context export` (xcode target/scheme, figma file URL) — read-only annotations the skill layer fills.
- **Tier 2 (high value for UI work):** SwiftUI-aware codemap v2 — extract property wrappers as API surface, mark `body: some View`, list `#Preview` blocks (~250 LOC on bead 9); asset-catalog summarizer (".xcassets: AppIcon + 8 colors + 23 images" instead of JSON internals).
- **Not doing (over-engineering):** Xcode build integration inside rp-mini, Figma node embedding, full pbxproj parsing, storyboard visual parsing, CSS/Tailwind design-token federation. TSX codemaps already capture component props/exports adequately.

## 5. Configurability

`rp-mini.config.json` (workspace) merged over `~/.config/rp-mini/config.json` (user) over defaults; env `RP_MINI_*` overrides; per-call tool args override all.

```jsonc
{
  "roots": ["."],
  "tokenizer": "heuristic",            // "heuristic" | "tiktoken:o200k_base"
  "budgets": { "discovery": 160000, "plan": 120000 },
  "caps": { "search_chars": 50000, "structure_tokens": 6000, "tree_tokens": 10000,
            "git_patch_lines": 300, "file_size_bytes": 10000000 },
  "codemaps": { "languages": ["ts","tsx","js","py","swift","go","rust","java","c","cpp","c_sharp","ruby","php","dart"],
                "cache_dir": ".rp-mini/codemap-cache" },
  "tools": { "apply_edits": true, "file_actions": true, "git": true },  // per-tool enable
  "selection": { "auto_codemaps": true, "persist": true, "scope": "session" },  // "session" | "workspace"
  "context_builder": { "enhancement": "rewrite",        // "rewrite" | "augment" | "preserve"
                       "intent_detection": true },       // review-hotword auto-detection
  "presets": { /* standard|plan|review|diff-followup built-in; user-defined here */ },
  "packager": { "section_order": ["file_map","file_contents","git_diff","meta_prompts","user_instructions"],
                "duplicate_instructions_at_top": false },
  "concurrency": { "parse_workers": 4, "search_max": 4 },
  "daemon": { "keep_alive": false, "idle_timeout_s": 300, "max_rss_mb": 1500 },
  "paths": "relative"                   // path display
}
```

**Section order stays deterministic** (configurable, not model-decided): stable context first → instructions last is deliberate — it matches recency bias *and* makes the long prefix prompt-cache-friendly for downstream API calls. CE's "Diff Formatting" section belonged to the deprecated XML edit modes and is dropped.

## 6. Implementation plan (beads)

| Bead | Scope | Risk |
|---|---|---|
| 1 | Monorepo scaffold, config loader, MCP server skeleton with stub tools, CI | Low |
| 2 | Catalog: walk + ignore stack + caps + chokidar revalidation | Low |
| 3 | Search: ripgrep bridge, modes, fuzzy path scoring, caps/limit_hit; `read_file`; `get_file_tree` | Med |
| 4 | CodeMaps v1: TS/TSX/JS/Python/Go/Rust via tree-sitter queries (port CE's .scm logic), FileAPI serializer, cache; `get_code_structure` | Med |
| 5 | Tokens + selection state machine + slices math + persistence; `manage_selection`, `workspace_context`, `prompt` | Med |
| 6 | Packager: XML payload assembly + export; golden tests against CE's format | Low |
| 7 | apply_edits ladder + batch deltas + indent re-anchor; `file_actions`; golden tests incl. escape/fuzzy/ambiguity cases | High (correctness) |
| 8 | `git` tool | Low |
| 9 | CodeMaps v2: Swift/Java/C/C++/C#/Ruby/PHP/Dart | Low |
| 10 | cc-plugin: manifest, .mcp.json, context-builder agent, skills | Low |
| 11 | codex-plugin: TOML snippet, skills install, AGENTS.md snippet | Low |
| 12 | Bench vs CE on a large repo (index time, search latency, context-build wall clock, tokens) + **multi-agent stress test: 4+ concurrent sessions, no blocking** + docs | Med |

Bead-2 scope includes the `rp-mini index` warm command, atomic shared-cache writes, lazy grammar loading, and the iOS-aware ignore preset; bead-3 includes the search relevance ranker; bead-4 includes the codemap size gate + type→file index; bead-5 includes per-session selection scope + named profiles + token delta-accounting; bead-6 includes presets + section-order config + content-hashed snapshots + the export receipt format; bead-10 includes the SessionStart warm hook and the intent-detection function in the context-builder agent; bead-11 includes the **Codex subagent config** for the context-builder (shared discovery-prompt module; `rp-mini build-context` headless fallback deferred post-MVP). iOS Tier-2 items (SwiftUI codemap v2, asset-catalog summarizer) are post-MVP follow-ups to bead 9.

TDD per global contract; golden-file tests for codemap output and packaged-prompt format (CE's test fixtures at `Tests/RepoPromptTests/CodeMap/Goldens/` are directly reusable as references).

## 7. Open questions / risks

- **Name** — `rp-mini` is a working title; trademark courtesy w.r.t. "RepoPrompt" worth a check before publishing.
- **Slice rebase** — CE re-anchors slice line-ranges when files change (signature matching). v1: invalidate slices on content change (simple, honest); port anchor-rebase later if churn annoys.
- **Auto-codemap dependency discovery** quality depends on `referencedTypes` extraction; v1 ships name-based matching (type name → defining file via codemap index), which is what CE effectively does.
- **WASM tree-sitter perf** on very large repos — mitigated by native bindings as default and the sha+mtime cache (cold-index once).
