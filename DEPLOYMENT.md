# DEPLOYMENT.md - rp-mini

## Build And Test

- Install: `pnpm install`
- Generate shared plugin prompts: `pnpm build:prompts`
- Build: `pnpm build`
- Format check: `pnpm format:check`
- Test: `pnpm test`
- Benchmark: `node scripts/bench.mjs [corpusPath]`

CI should run prompt generation, build, format, and tests before merge. Main must stay deployable.

## Run Standalone

After `pnpm build`, run the stdio MCP server directly:

```sh
node packages/server/dist/cli.js serve --root /path/to/workspace
```

When packaged, the bin name is `rp-mini`, so the equivalent command is:

```sh
npx rp-mini serve --root /path/to/workspace
```

The server uses stdio and binds no TCP port. No port-collision check is needed unless a future transport is added.

## Warm Cache

Warm catalog and codemap caches:

```sh
node packages/server/dist/cli.js index /path/to/workspace
```

The warm command writes `.rp-mini/catalog.json` and `.rp-mini/codemap-cache/*.json`. Warming is optional; normal tool calls verify files on read and build missing cache entries lazily.

## Runtime Storage

Runtime files are stored under each workspace root:

| Path | Purpose |
| --- | --- |
| `.rp-mini/catalog.json` | CLI warm snapshot for inspection. |
| `.rp-mini/codemap-cache/` | Shared atomic JSON codemap cache. |
| `.rp-mini/sessions/` | Per-session selection state when persistence is enabled. |
| `.rp-mini/profiles/` | Named selection profiles. |
| `.rp-mini/exports/` | Markdown exports and JSON receipts from `workspace_context op=export`. |

The cache is safe for multiple stdio server processes: writes use temp-file plus rename, and readers ignore invalid JSON.

## Plugin Consumption

Claude Code:
- Plugin root: `packages/cc-plugin`
- Local install: `claude plugin install ./packages/cc-plugin`
- MCP config: `packages/cc-plugin/.mcp.json`
- Generated context-builder agent: `packages/cc-plugin/agents/context-builder.md`
- Skills: `packages/cc-plugin/skills/rp-*`

Codex:
- Plugin root: `packages/codex-plugin`
- Local install: `packages/codex-plugin/install.sh`
- Optional config write: `packages/codex-plugin/install.sh --write-config`
- MCP snippet: `packages/codex-plugin/config/mcp-servers.toml`
- Generated context-builder skill: `packages/codex-plugin/skills/context-builder/SKILL.md`
- Skills installed under `~/.codex/skills/rp-mini-*`

Both plugins consume the same server command and shared discovery prompt source.

Shell CLI smoke:

```sh
node packages/server/dist/cli.js --help
node packages/server/dist/cli.js search /path/to/workspace ContextBuilder --max-results 10
node packages/server/dist/cli.js tree /path/to/workspace --mode folders --max-depth 3
node packages/server/dist/cli.js tool /path/to/workspace file_search --json-args '{"pattern":"ContextBuilder","max_results":3}'
```

## Release Checklist Placeholder

1. Bump package versions from `0.0.0`.
2. Run `pnpm install`, `pnpm build:prompts`, `pnpm build`, `pnpm format:check`, and `pnpm test`.
3. Run `node scripts/bench.mjs ../repoprompt-ce --date <YYYY-MM-DD>` and update `docs/bench.md`.
4. Verify Claude plugin install from a clean checkout.
5. Verify Codex plugin install and `--write-config` idempotence in a temporary HOME.
6. Verify shell CLI help/search/tree/generic-tool smoke commands.
7. Verify `node packages/server/dist/cli.js serve --root <fixture>` with a real MCP client.
8. Confirm `THIRD_PARTY_NOTICES.md` and Apache-2.0 attribution are current.
9. Tag release and publish packages/artifacts after review.

Rollback before first public release: revert the bead branch or remove installed plugin files with the Codex uninstall path and Claude plugin manager.
