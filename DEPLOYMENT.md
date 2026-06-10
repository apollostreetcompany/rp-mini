# DEPLOYMENT.md - rp-mini

## Runtime
- Node.js >= 22.
- Package manager: pnpm 10.16.1.
- Module format: ESM.
- Search runtime: `file_search` resolves ripgrep via `Config.search.ripgrep_path` / `RP_MINI_RIPGREP_PATH`, then optional `@vscode/ripgrep`, then PATH `rg`.

## Local Commands
- Install: `pnpm install`
- Build: `pnpm build`
- Format check: `pnpm format:check`
- Test: `pnpm test`
- CLI index smoke: `node packages/server/dist/cli.js index .`

## MCP Server
- Bin name: `rp-mini`
- Stdio command after build/package linking: `rp-mini serve --root <path>`
- Default root when no `--root` is passed: current working directory.
- `file_search`, `read_file`, and `get_file_tree` are real handlers as of Bead 3; the other seven tools remain intentional stubs until their beads.
- `rp-mini index [path]` writes `.rp-mini/catalog.json`.

## Deployment Status
- No hosted deployment target yet.
- No ports are bound by the Bead 1 stdio server path.
- Rollback before first release: revert the Bead 1 scaffold commit after supervisor review.
