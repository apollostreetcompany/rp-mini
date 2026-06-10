# MISTAKES.md - rp-mini

Mistakes to avoid and lessons learned. Add entries when an error happens twice or when the prompt says "oops".

1. (design phase) Don't gate codemaps by file size — large source files are where codemaps matter most. Gate only generated/minified content; cap codemap OUTPUT instead.
2. (design phase) Don't assume host capabilities from a reference implementation's config — CE's `multiAgentEnabled: false` was CE's choice, not a Codex platform limit. Verify against current platform docs.
