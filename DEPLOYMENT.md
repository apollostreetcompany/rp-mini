# DEPLOYMENT.md - rp-mini

## Runtime
- Node.js >= 22.
- Package manager: pnpm 10.16.1.
- Module format: ESM.

## Local Commands
- Install: `pnpm install`
- Build: `pnpm build`
- Format check: `pnpm format:check`
- Test: `pnpm test`
- CLI stub smoke: `node packages/server/dist/cli.js index .`

## MCP Server
- Bin name: `rp-mini`
- Stdio command after build/package linking: `rp-mini serve --root <path>`
- Default root when no `--root` is passed: current working directory.
- `rp-mini index [path]` is intentionally stubbed in Bead 1 and prints `not implemented`.

## Deployment Status
- No hosted deployment target yet.
- No ports are bound by the Bead 1 stdio server path.
- Rollback before first release: revert the Bead 1 scaffold commit after supervisor review.
