# HANDOFF.md - rp-mini

Pre-compaction context handoff. Updated before context compaction and at major milestones.

## Current state (2026-06-10)
- Design complete and user-approved: docs/plans/rp-mini-design-2026-06-10.md (v4, build-approved).
- Repo bootstrapped with workflow contract files; GitHub remote: apollostreetcompany/rp-mini (private).
- Bead 1 implementation complete in the working tree via Codex implementation agent (scaffold + config + server skeleton + CI), awaiting supervisor review/commit/push.

## Key context for a fresh agent
- Read AGENTS.md → CONTINUITY.md → the design doc, in that order.
- Reference implementation: ../repoprompt-ce (Apache 2.0). Reuse its codemap golden fixtures for parity tests.
- Implementation agents: Codex (GPT-5.5-fast); primary agent reviews, runs tests, commits, pushes.
- Local Bead 1 validation passed: `pnpm build`, `pnpm format:check`, `pnpm test`, and `node packages/server/dist/cli.js index .`.
- `handoff/beads.jsonl` was not appended by the implementation agent because no commit SHA exists yet; supervisor should append final bead evidence after review and commit.
