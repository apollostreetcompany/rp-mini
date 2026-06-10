# rp-mini

rp-mini is a minimal context-engineering MCP server for coding agents. It keeps RepoPrompt's core context workflow — fast search, codemaps, curated selections, packaged exports, and safe edits — without requiring a GUI app. It is designed for one stdio server process per agent session so concurrent agents do not serialize through one shared app process.

## Install

### Claude Code

1. Build the workspace: `pnpm install && pnpm build && pnpm build:prompts`
2. Install the local plugin: `claude plugin install ./packages/cc-plugin`
3. Marketplace distribution: TBD.

The Claude plugin lives at `packages/cc-plugin` and includes `.mcp.json`, a generated context-builder agent, `rp-*` skills, and a SessionStart warm hook.

### Codex

1. Build the workspace: `pnpm install && pnpm build && pnpm build:prompts`
2. Install skills and print the MCP config snippet: `bash packages/codex-plugin/install.sh`
3. To append the MCP snippet to `~/.codex/config.toml`, rerun with `--write-config`.

The Codex plugin lives at `packages/codex-plugin`; uninstall with `bash packages/codex-plugin/install.sh --uninstall`.

## Configuration

Config layers are defaults, `~/.config/rp-mini/config.json`, workspace `rp-mini.config.json`, environment variables, then host overrides.

| Key | Default | Effect |
| --- | --- | --- |
| `roots` | `["."]` | Workspace roots served by the MCP process. |
| `tokenizer` | `heuristic` | Token estimator used for budgets and context receipts. |
| `budgets.discovery` | `160000` | Default discovery/export budget. |
| `budgets.plan` | `120000` | Planning preset budget. |
| `caps.search_chars` | `50000` | Response character budget for search shaping. |
| `caps.structure_tokens` | `6000` | Codemap response token cap. |
| `caps.tree_tokens` | `10000` | File tree response token cap. |
| `caps.git_patch_lines` | `300` | Git patch lines included in review exports. |
| `caps.file_size_bytes` | `10000000` | Oversized-file threshold for catalog/search safety. |
| `codemaps.languages` | `ts, tsx, js, py, swift, go, rust, java, c, cpp, c_sharp, ruby, php, dart` | Languages eligible for codemap extraction. |
| `codemaps.cache_dir` | `.rp-mini/codemap-cache` | Shared atomic codemap cache location under the root. |
| `ignore.extra` | `[]` | Additional ignore globs. |
| `ignore.ios_preset` | `auto` | Applies iOS/Xcode ignore behavior when relevant. |
| `search.ripgrep_path` | unset | Optional explicit `rg` binary path. |
| `tools.apply_edits` | `true` | Enables the edit tool. |
| `tools.file_actions` | `true` | Enables create/delete/move tool. |
| `tools.git` | `true` | Enables read-only git tool. |
| `selection.auto_codemaps` | `true` | Adds codemap-only dependencies for selected files. |
| `selection.persist` | `true` | Persists per-session selections in `.rp-mini/sessions`. |
| `selection.scope` | `session` | Selection storage scope; `workspace` uses shared state. |
| `context_builder.enhancement` | `rewrite` | Prompt enhancement mode for context-builder skills. |
| `context_builder.intent_detection` | `true` | Enables preset inference from user instructions. |
| `presets` | `standard`, `plan`, `review`, `diff-followup`, `mvp` | Controls export sections, trees, codemaps, git diff, and meta prompts. |
| `packager.section_order` | `file_map, file_contents, git_diff, meta_prompts, user_instructions` | XML export section order. |
| `packager.duplicate_instructions_at_top` | `false` | Optionally repeats user instructions before the payload. |
| `concurrency.parse_workers` | `4` | Per-process codemap parse worker count. |
| `concurrency.search_max` | `4` | Intended per-process search concurrency bound. |
| `daemon.keep_alive` | `false` | Placeholder for post-MVP daemon mode. |
| `daemon.idle_timeout_s` | `300` | Post-MVP daemon idle timeout. |
| `daemon.max_rss_mb` | `1500` | Post-MVP daemon memory ceiling. |
| `paths` | `relative` | Preferred path display style. |

Environment variables use the `RP_MINI_` prefix; see `packages/core/src/config/index.ts` for exact names.

## Tools

| Tool | Purpose |
| --- | --- |
| `file_search` | Search by path, content, or both through catalog-approved files. |
| `read_file` | Read full files, line ranges, or negative tail ranges. |
| `get_file_tree` | Render capped trees in auto, full, folders, or selected mode. |
| `get_code_structure` | Return codemap signatures for files, directories, or selected scope. |
| `manage_selection` | Add, set, remove, promote, demote, save, or load context selections. |
| `workspace_context` | Snapshot or export packaged context with token accounting. |
| `prompt` | Get, set, append, or clear handoff instructions. |
| `apply_edits` | Apply fail-closed rewrite or search/replace edits. |
| `file_actions` | Create, delete, or move files with guardrails. |
| `git` | Read-only status, diff, log, show, and blame. |

## Benchmarks

Run `node scripts/bench.mjs [corpusPath]` after `pnpm build`. The current measured reference-corpus results are in [docs/bench.md](docs/bench.md).

## Design

The canonical plan is [docs/plans/rp-mini-design-2026-06-10.md](docs/plans/rp-mini-design-2026-06-10.md).

## License And Attribution

rp-mini is licensed under Apache-2.0. Portions of the design and algorithms are derived from RepoPrompt CE, also Apache-2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
