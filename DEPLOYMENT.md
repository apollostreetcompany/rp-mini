# DEPLOYMENT.md - rp-mini

## Runtime
- Node.js >= 22.
- Package manager: pnpm 10.16.1.
- Module format: ESM.
- Search runtime: `file_search` resolves ripgrep via `Config.search.ripgrep_path` / `RP_MINI_RIPGREP_PATH`, then optional `@vscode/ripgrep`, then PATH `rg`.
- CodeMap parser runtime: `@vscode/tree-sitter-wasm` for VS Code-shipped grammars; `tree-sitter-wasms@0.1.13` supplies prebuilt Swift, C, and Dart WASM grammars for Bead 9.

## Local Commands
- Install: `pnpm install`
- Build: `pnpm build`
- Build generated plugin prompts: `pnpm build:prompts`
- Format check: `pnpm format:check`
- Test: `pnpm test`
- CLI index smoke: `node packages/server/dist/cli.js index .`

## MCP Server
- Bin name: `rp-mini`
- Stdio command after build/package linking: `rp-mini serve --root <path>`
- Default root when no `--root` is passed: current working directory.
- Claude Code plugin config: `packages/cc-plugin/.mcp.json` starts `node ${CLAUDE_PLUGIN_ROOT}/../server/dist/cli.js serve`; if plugin-root relative resolution is unavailable, use the documented `npx rp-mini serve` fallback after packaging.
- `file_search`, `read_file`, `get_file_tree`, `get_code_structure`, `manage_selection`, `workspace_context`, `prompt`, `apply_edits`, `file_actions`, and `git` are real handlers as of Bead 8.
- `rp-mini index [path]` writes `.rp-mini/catalog.json`.

## Claude Code Plugin
- Plugin root: `packages/cc-plugin`.
- Install from checkout after build: `claude plugin install ./packages/cc-plugin`.
- Generated agent: `packages/cc-plugin/agents/context-builder.md`, rendered from `shared-prompts/discovery/contract.md` via `pnpm build:prompts`.
- Optional warm hook: `hooks/hooks.json` runs `rp-mini index .` in the background on `SessionStart`; warming is never required for correctness and no tool call waits on it.

## Codex Plugin
- Plugin root: `packages/codex-plugin`.
- Install from checkout after build and prompt generation: `bash packages/codex-plugin/install.sh`.
- Skills install under `~/.codex/skills/rp-mini-*`; source skill directories remain unprefixed under `packages/codex-plugin/skills/`.
- Generated context-builder skill: `packages/codex-plugin/skills/context-builder/SKILL.md`, rendered from `shared-prompts/discovery/contract.md` via `pnpm build:prompts`.
- MCP config snippet: `packages/codex-plugin/config/mcp-servers.toml` uses Codex's `[mcp_servers.rp-mini]` shape with `command = "node"` and `args = ["<abs packages/server/dist/cli.js>", "serve"]`.
- Installer does not edit `~/.codex/config.toml` by default; `--write-config` appends only when `[mcp_servers.rp-mini]` is absent. `--uninstall` removes only `~/.codex/skills/rp-mini-*`.

## Deployment Status
- No hosted deployment target yet.
- No ports are bound by the Bead 1 stdio server path.
- Rollback before first release: revert the Bead 1 scaffold commit after supervisor review.
