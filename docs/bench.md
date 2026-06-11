# rp-mini Benchmarks

Measured on 2026-06-11. Each metric is the median of N=3 runs using `process.hrtime.bigint()`.

## Corpus

- Source: `/Users/kikimac/Documents/repoprompt-ce-refactor/repoprompt-ce`
- Measurement root: temporary copy at `/var/folders/9t/rqwj032x3z906mrrylj03ts80000gn/T/rp-mini-bench-12496-1eb067b7-00fc-4a2e-9d99-93d1a0c0bcc0`
- Files: 1758
- Directories: 354
- Ignored entries: 6
- Cataloged bytes: 28144890
- Machine: Apple M3 Ultra
- Node: v22.22.2

The benchmark reads `../repoprompt-ce` but does not write to it. Cache and export writes happen inside the temporary measurement root.

## Results

| Metric | Median | Detail |
| --- | ---: | --- |
| Cold catalog index | 205.0 ms | 1758 files, 354 dirs |
| Cold codemap warm | 42424.8 ms | 1427 computed, 0 cached, 33.6 files/sec |
| Warm cached index | 332.7 ms | 1427 cached, 0 computed |
| file_search content 'CodeMap' | 8.5 ms | 25 matches, limit_hit=true |
| file_search content 'MCPFilesystemIdentity' | 31.2 ms | 25 matches, limit_hit=true |
| file_search content 'TreeSitter' | 8.4 ms | 25 matches, limit_hit=true |
| file_search path 'package' | 9.8 ms | 25 matches, limit_hit=true |
| get_code_structure Sources/CSwiftPCRE2/src | 13.2 ms | 10 files, omitted=36 |
| workspace_context export 20 files | 271.0 ms | 29955 tokens, hash 09233c8afb10 |

## Tree Quality

Selected anchors for tree quality: `.agents/skills/rpce-contribution-check/agents/openai.yaml`, `Sources/RepoPrompt/App/Sparkle/AppcastParser.swift`, `Sources/RepoPrompt/Features/AgentMode/Views/ToolCards/ToolResultPromptCard.swift`, `Sources/RepoPrompt/Features/Workspaces/Views/WorkspaceEntryRootView.swift`, `Sources/RepoPrompt/Infrastructure/MCP/ApplyEdits/ApplyEditsEscapeFallback.swift`, `Sources/RepoPrompt/Infrastructure/UI/Components/WorkspaceApprovalOverlayView.swift`, `Tests/RepoPromptTests/App/AppPlatformUtilityRecoveryTests.swift`, `ThirdPartyLicenses/swiftpm/swift-nio-extras/NOTICE.txt`, `Vendor/UniversalCharsetDetection/uchardet/script/release.sh`, `version.env`.

| Budget | Median render | Tokens used | Anchor retention | Top-level coverage |
| ---: | ---: | ---: | ---: | ---: |
| 2000 | 31.0 ms | 1784/2000 | 37/37 (100.0%) | 11/11 (100.0%) |
| 5000 | 23.2 ms | 2939/5000 | 37/37 (100.0%) | 11/11 (100.0%) |
| 10000 | 23.3 ms | 2939/10000 | 37/37 (100.0%) | 11/11 (100.0%) |

## Notes

- No ARG_MAX failure observed during content searches with 1758 catalog-approved files.
- `get_code_structure` directory: `Sources/CSwiftPCRE2/src`
- Workspace export selected 20 files.
- This is not a CE-side comparative benchmark; it proves rp-mini's local behavior on the reference corpus.
