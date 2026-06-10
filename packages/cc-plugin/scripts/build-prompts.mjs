#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pluginRoot, "../..");
const contractPath = join(repoRoot, "shared-prompts/discovery/contract.md");
const agentPath = join(pluginRoot, "agents/context-builder.md");

const tools = [
  "mcp__rp-mini__file_search",
  "mcp__rp-mini__read_file",
  "mcp__rp-mini__get_file_tree",
  "mcp__rp-mini__get_code_structure",
  "mcp__rp-mini__manage_selection",
  "mcp__rp-mini__workspace_context",
  "mcp__rp-mini__prompt",
  "mcp__rp-mini__git",
  "Read",
];

const contract = (await readFile(contractPath, "utf8")).trim();
const body = `---
name: context-builder
description: Use for autonomous context curation before implementation, planning, investigation, refactoring, or review; selects files and writes a handoff prompt without implementing.
tools: [${tools.join(", ")}]
model: inherit
---

<!-- BEGIN GENERATED DISCOVERY CONTRACT -->
${contract}
<!-- END GENERATED DISCOVERY CONTRACT -->
`;

await mkdir(dirname(agentPath), { recursive: true });
await writeFile(agentPath, body);
