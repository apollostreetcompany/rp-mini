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
2. Install skills and print the MCP config snippet: `packages/codex-plugin/install.sh`
3. To append the MCP snippet to `~/.codex/config.toml`, rerun with `--write-config`.

The Codex plugin lives at `packages/codex-plugin`; uninstall with `packages/codex-plugin/install.sh --uninstall`.

## Shell CLI

The server package also exposes a direct shell CLI for use without a loaded Codex, Claude, or MCP client:

```sh
node packages/server/dist/cli.js --help
node packages/server/dist/cli.js index /path/to/workspace
node packages/server/dist/cli.js search /path/to/workspace ContextBuilder --max-results 20
node packages/server/dist/cli.js read /path/to/workspace Sources/App.ts --start-line 40 --limit 80
node packages/server/dist/cli.js tree /path/to/workspace --mode folders --max-depth 3
node packages/server/dist/cli.js structure /path/to/workspace Sources/App.ts
node packages/server/dist/cli.js serve --profile explorer --root /path/to/workspace
```

Common wrappers cover search, read, tree, structure, selection, prompt/context packaging, git, edits, file actions, token counting, and indexing. Any MCP tool can also be invoked directly:

```sh
node packages/server/dist/cli.js tool /path/to/workspace file_search --json-args '{"pattern":"ContextBuilder","max_results":10}'
node packages/server/dist/cli.js tool /path/to/workspace apply_edits --profile explorer --json-args '{"path":"src/a.ts","search":"old","replace":"new","dry_run":true}'
```

## Configuration

Config layers are defaults, `~/.config/rp-mini/config.json`, workspace `rp-mini.config.json`, environment variables, then host overrides.

| Key | Default | Effect |
| --- | --- | --- |
| `roots` | `["."]` | Workspace roots served by the MCP process. |
| `profile` | `full` | Role profile: `full`, `editor`, or `explorer`. |
| `tokenizer` | `heuristic` | Token estimator used for budgets and context receipts. |
| `budgets.discovery` | `160000` | Default discovery/export budget. |
| `budgets.plan` | `120000` | Planning preset budget. |
| `caps.search_chars` | `50000` | Response character budget for search shaping. |
| `caps.structure_tokens` | `6000` | Codemap response token cap. |
| `caps.tree_tokens` | `10000` | Default adaptive file tree token cap; auto mode degrades from full tree toward summarized/selected views while preserving anchors. |
| `caps.git_patch_lines` | `300` | Git patch lines included in review exports. |
| `caps.file_size_bytes` | `10000000` | Oversized-file threshold for catalog/search safety. |
| `codemaps.languages` | `ts, tsx, js, py, swift, go, rust, java, c, cpp, c_sharp, ruby, php, dart` | Languages eligible for codemap extraction. |
| `codemaps.cache_dir` | `.rp-mini/codemap-cache` | Shared atomic codemap cache location under the root. |
| `ignore.extra` | `[]` | Additional ignore globs. |
| `ignore.ios_preset` | `auto` | Applies iOS/Xcode ignore behavior when relevant. |
| `search.ripgrep_path` | unset | Optional explicit `rg` binary path. |
| `dynamic_roots.enabled` | `true` | Allows each MCP call to target an absolute alternative workspace root. |
| `dynamic_roots.max` | `4` | Maximum number of dynamic root contexts cached per server process. |
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

## Role Profiles

Profiles make a server process announce and enforce its role. Launch one process per role: start an explorer with `rp-mini serve --profile explorer --root /path/to/workspace`, and start a separate editor/full process when mutation tools should be available.

| Profile | Tool surface |
| --- | --- |
| `full` | All tools, clamped by `tools.*` booleans. |
| `editor` | Same surface as `full` today, kept distinct so hosts can pin intent and future tools can diverge. |
| `explorer` | Read-only exploration and context tools; `apply_edits` and `file_actions` are disabled. `git` remains available because it is read-only. |

Profiles compose with `tools.*` as a clamp: a tool is enabled only when the active profile allows it and the matching `tools.*` boolean is true. Disabled tools remain visible in MCP tool listings and return structured payloads such as `tool_disabled_by_profile` or `tool_disabled_by_config` instead of disappearing. `workspace_context` includes `server.profile`, `server.tools_enabled`, and `server.tools_disabled`, and the MCP server instructions include the same active profile and disabled-tool reasons. `RP_MINI_PROFILE` sets the environment profile; `serve --profile <name>` or wrapper `--profile <name>` wins over environment and config files.

## Tools

Every MCP tool accepts optional `root`, an absolute workspace path that targets that single call without rebinding the server process. Profile is process-level and clamps every targeted workspace: an `explorer` process can read any allowed root, but mutation tools refuse with `tool_disabled_by_profile` even if the target workspace's own config enables them.

| Tool | Purpose |
| --- | --- |
| `file_search` | Search by path, content, or both through catalog-approved files. |
| `read_file` | Read full files, line ranges, or negative tail ranges. |
| `get_file_tree` | Render capped trees in auto, full, folders, or selected mode; accepts optional `max_tokens` up to 50000 for per-call tree budgets. |
| `get_code_structure` | Return codemap signatures for files, directories, or selected scope. |
| `manage_selection` | Add, set, remove, promote, demote, save, or load context selections. |
| `workspace_context` | Snapshot or export packaged context with token accounting. |
| `prompt` | Get, set, append, or clear handoff instructions. |
| `apply_edits` | Preview or apply fail-closed rewrite/search/replace edits with `dry_run`, `expected_sha256`, and post-apply proof. |
| `file_actions` | Create, delete, or move files with guardrails; delete/move can require `expected_sha256`. |
| `git` | Read-only status, diff, log, show, and blame. |

Use `apply_edits` with `dry_run: true` to get the full match result, `unified_diff`, and `pre_sha256` without writing. After approval, call the same edit with `expected_sha256: <pre_sha256>` so stale files fail closed before matching. Successful applies return `verified: true`, `post_sha256`, and line-numbered `post_context` slices from the final file.

## Benchmarks

Run `node scripts/bench.mjs [corpusPath]` after `pnpm build`. The current measured reference-corpus results are in [docs/bench.md](docs/bench.md).

## Design

The canonical plan is [docs/plans/rp-mini-design-2026-06-10.md](docs/plans/rp-mini-design-2026-06-10.md).

## License And Attribution

rp-mini is licensed under Apache-2.0. Portions of the design and algorithms are derived from RepoPrompt CE, also Apache-2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
