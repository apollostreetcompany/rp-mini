# MISTAKES.md - rp-mini

Mistakes to avoid and lessons learned. Add entries when an error happens twice or when the prompt says "oops".

1. (design phase) Don't gate codemaps by file size — large source files are where codemaps matter most. Gate only generated/minified content; cap codemap OUTPUT instead.
2. (design phase) Don't assume host capabilities from a reference implementation's config — CE's `multiAgentEnabled: false` was CE's choice, not a Codex platform limit. Verify against current platform docs.
3. (bead 1) `codex exec -m gpt-5.5-fast` fails on this ChatGPT-account setup ("model is not supported"); use the config default `gpt-5.5` with `-c model_reasoning_effort="medium"` for fast implementation runs. Also: codex exec can exit 0 despite a fatal model error — always check the log for `ERROR:` lines before trusting completion.
4. (bead 13) For this Codex CLI build, approval/sandbox flags such as `-a never` and `-s danger-full-access` must be placed before the `exec` subcommand when using `codex exec`; placing `--ask-for-approval` after `exec` exits with usage code 2. Do not combine `-a never` with `--dangerously-bypass-approvals-and-sandbox`; the bypass flag already owns approval/sandbox behavior.
