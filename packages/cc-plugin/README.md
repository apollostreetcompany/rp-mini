# rp-mini Claude Code Plugin

Claude Code package for rp-mini: MCP server config, `context-builder` subagent, workflow skills, and an optional warm hook.

## Install

From a checkout:

```bash
pnpm install
pnpm build
pnpm build:prompts
claude plugin install ./packages/cc-plugin
```

Marketplace publishing is deferred.

## MCP Server

The plugin configures one MCP server:

```json
{
  "mcpServers": {
    "rp-mini": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../server/dist/cli.js", "serve"]
    }
  }
}
```

If `${CLAUDE_PLUGIN_ROOT}` relative resolution is unavailable in a host, use a user-level fallback after publishing:

```json
{
  "mcpServers": {
    "rp-mini": {
      "command": "npx",
      "args": ["rp-mini", "serve"]
    }
  }
}
```

## Config Precedence

rp-mini config precedence is:

1. Per-call tool arguments.
2. `RP_MINI_*` environment variables.
3. Workspace `rp-mini.config.json`.
4. User `~/.config/rp-mini/config.json`.
5. Built-in defaults.

## Tools

- `file_search`
- `read_file`
- `get_file_tree`
- `get_code_structure`
- `manage_selection`
- `workspace_context`
- `prompt`
- `apply_edits`
- `file_actions`
- `git`

## Context Builder

`agents/context-builder.md` is generated from `../../shared-prompts/discovery/contract.md` by:

```bash
pnpm build:prompts
```

Do not edit the generated agent body by hand. Update the shared contract and rebuild.

## SessionStart Warm Hook

`hooks/hooks.json` runs `rp-mini index .` in the background. It is optional: warming improves first-call latency, but correctness never depends on it and no tool call waits for it.
