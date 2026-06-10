# rp-mini Codex Plugin

Codex packaging for rp-mini: MCP config snippet, installable skills, and an AGENTS.md usage block. It uses the same shared discovery contract as `packages/cc-plugin`.

## Install

Build the server first so the generated TOML points at an existing CLI:

```sh
pnpm build
pnpm --filter @rp-mini/codex-plugin build:prompts
bash packages/codex-plugin/install.sh
```

The installer copies skills into `~/.codex/skills/` with `rp-mini-` prefixes:

- `rp-mini-context-builder`
- `rp-mini-rp-build`
- `rp-mini-rp-investigate`
- `rp-mini-rp-review`
- `rp-mini-rp-refactor`
- `rp-mini-rp-plan`
- `rp-mini-rp-export`

By default it does not modify `~/.codex/config.toml`; it prints `config/mcp-servers.toml` for manual merge. To append the snippet only when `[mcp_servers.rp-mini]` is absent:

```sh
bash packages/codex-plugin/install.sh --write-config
```

## Uninstall

```sh
bash packages/codex-plugin/install.sh --uninstall
```

`--uninstall` removes only `~/.codex/skills/rp-mini-*` directories. It does not edit `~/.codex/config.toml`.

## What Gets Configured

The TOML snippet registers:

```toml
[mcp_servers.rp-mini]
command = "node"
args = ["/absolute/path/to/packages/server/dist/cli.js", "serve"]
```

The snippet also documents the future npx fallback:

```toml
# command = "npx", args = ["rp-mini", "serve"]
```

## Parity With Claude Code Plugin

The Codex context-builder skill renders the same `shared-prompts/discovery/contract.md` used by the Claude Code `context-builder` agent. The six rp-* workflow skills are Codex-flavored: they use Codex native subagent delegation and clarify ambiguous scope by presenting numbered options in chat and waiting, matching the repository AGENTS.md tool-mapping convention.
