# rp-mini Benchmarks

Measured on 2026-06-10. Each metric is the median of N=3 runs using `process.hrtime.bigint()`.

## Corpus

- Source: `/Users/kikimac/Documents/repoprompt-ce-refactor/rp-mini`
- Measurement root: temporary copy at `/var/folders/9t/rqwj032x3z906mrrylj03ts80000gn/T/rp-mini-bench-51814-65fbc549-89b3-45b8-908d-2cb07a7a6ce6`
- Files: 108
- Directories: 52
- Ignored entries: 12
- Cataloged bytes: 551012
- Machine: Apple M3 Ultra
- Node: v22.22.2

The benchmark reads `../repoprompt-ce` but does not write to it. Cache and export writes happen inside the temporary measurement root.

## Results

| Metric | Median | Detail |
| --- | ---: | --- |
| Cold catalog index | 16.3 ms | 108 files, 52 dirs |
| Cold codemap warm | 352.9 ms | 52 computed, 0 cached, 147.3 files/sec |
| Warm cached index | 27.9 ms | 52 cached, 0 computed |
| file_search content 'CodeMap' | 8.0 ms | 12 matches, limit_hit=false |
| file_search content 'MCPFilesystemIdentity' | 8.0 ms | 2 matches, limit_hit=false |
| file_search content 'TreeSitter' | 7.2 ms | 2 matches, limit_hit=false |
| file_search path 'package' | 0.6 ms | 25 matches, limit_hit=true |
| get_code_structure packages/core/src/codemaps/fixtures | 2.1 ms | 10 files, omitted=6 |
| workspace_context export 20 files | 25.0 ms | 24060 tokens, hash 60cae7c56105 |

## Notes

- No ARG_MAX failure observed during content searches with 108 catalog-approved files.
- `get_code_structure` directory: `packages/core/src/codemaps/fixtures`
- Workspace export selected 20 files.
- This is not a CE-side comparative benchmark; it proves rp-mini's local behavior on the reference corpus.
