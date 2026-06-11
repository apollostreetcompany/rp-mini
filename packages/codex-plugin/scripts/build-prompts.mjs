#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pluginRoot, "../..");
const contractPath = join(repoRoot, "shared-prompts/discovery/contract.md");

const contract = (await readFile(contractPath, "utf8")).trim();

const contextBuilder = `---
name: context-builder
description: Codex native subagent instructions for rp-mini autonomous context curation before implementation, planning, investigation, refactoring, or review.
---

# rp-mini context-builder

Load this skill as the instruction source for a Codex native subagent. The subagent curates context with rp-mini and must not implement.

Invocation parameters from the calling rp-* skill:
- task: reformulated user request with concrete repo terms.
- budget: caller hard budget, 120k for plan work, or default discovery budget.
- response_type: \`plan\`, \`question\`, \`review\`, or \`clarify\`.
- enhancement mode: \`rewrite\`, \`augment\`, or \`preserve\`.

Codex clarification rule: when scope is ambiguous, the calling skill presents numbered options in chat and waits before launching this subagent. The subagent itself runs uninterrupted.

<!-- BEGIN GENERATED DISCOVERY CONTRACT -->
${contract}
<!-- END GENERATED DISCOVERY CONTRACT -->
`;

const skillDefinitions = {
  "rp-build": {
    description: "Build workflow using rp-mini context-builder before implementation.",
    body: `# rp-build

Use this when the user wants code changes and the task benefits from curated context.

Check workspace binding first. On mismatch, pass \`root=<absolute path>\` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use \`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'\` or its wrappers.

1. Verify the workspace is the intended repo and make a quick scan with rp-mini tools such as \`get_file_tree\`, \`file_search\`, or \`get_code_structure\`.
2. Clarify first: if task scope, target behavior, or acceptance criteria are ambiguous, present numbered options in chat and wait before launching the builder.
3. Load \`skills/context-builder\` (installed as \`rp-mini-context-builder\`) and run it as a Codex native subagent with:
   - task: reformulated user request with codebase terms from the quick scan
   - budget: default 120k for plan work unless caller supplied a hard budget
   - response_type: \`plan\`
   - enhancement mode: \`rewrite\` unless the user requested \`augment\` or \`preserve\`
4. Question loop: this is the rp-build/rp-investigate question loop. If the builder returns \`<questions>\` plus a saved profile name, read the cited files, check git history or searches, and answer only conclusive questions with \`<answer key="..." source="orchestrator" >...</answer>\`. Escalate only for blocking AND high-stakes questions: irreversible/destructive actions, product policy, money/auth/data-loss; present numbered options in chat and wait. Append \`<answers>\` with \`prompt op=append\`, resume with \`manage_selection op=load_profile\`, and remember advisory questions never interrupt.
5. Act on the handoff: implement directly against the curated selection and plan. Use existing repo patterns and avoid unrelated refactors.
6. Validate with relevant tests, lint/format, or build commands for the touched area.
7. Report changes, validation results, assumptions, and remaining risks.

Do not skip \`context-builder\` for non-trivial code work; the quick scan is orientation, not the deep exploration.
`,
  },
  "rp-export": {
    description: "Export rp-mini curated context for external models or proconsult.",
    body: `# rp-export

Use this when the user wants a packaged context file for another model, review tool, or proconsult-compatible workflow.

Check workspace binding first. On mismatch, pass \`root=<absolute path>\` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use \`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'\` or its wrappers.

1. Clarify first: if export purpose, scope, preset, or budget is ambiguous, present numbered options in chat and wait before launching the builder.
2. Load \`skills/context-builder\` (installed as \`rp-mini-context-builder\`) and run it as a Codex native subagent with:
   - task: curate export-ready context for the requested purpose
   - budget: caller budget or default discovery budget
   - response_type: \`question\` for evidence exports, \`plan\` for planning exports, or \`review\` for diff exports
   - enhancement mode: \`preserve\` when the user wants selection-only export; otherwise \`rewrite\`
3. If the builder returns \`<questions>\`, follow the question loop defined in rp-build/rp-investigate before continuing.
4. Inspect the resulting selection and token count with \`workspace_context include=["selection","tokens"]\`.
5. Export with \`workspace_context op=export\`, choosing the matching preset when provided (\`standard\`, \`plan\`, \`review\`, or \`diff-followup\`).
6. Hand the payload path and receipt path to the user. Mention that the payload is compatible with proconsult-style external model intake.
7. Cite the \`workspace_context op=export\` receipt: token totals, content hash, and saved handoff profile. If the caller asked for a durable artifact, write the export to a file with the host Write tool or shell CLI.
8. Report selected scope, token count, preset, assumptions, and any files deliberately excluded.

Do not paste large exported payloads into chat; provide paths and receipt details.
`,
  },
  "rp-investigate": {
    description: "Read-only investigation workflow using rp-mini context-builder.",
    body: `# rp-investigate

Use this for root-cause analysis, code archaeology, or "how/why is this happening?" questions. This workflow is read-only.

Check workspace binding first. On mismatch, pass \`root=<absolute path>\` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use \`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'\` or its wrappers.

Triage fast path: Bounded question (single subsystem, named symbol, roughly <=5 files) -> answer inline with \`file_search\`, \`read_file\`, and \`get_code_structure\`; do not spawn the builder. Broad, cross-cutting, or durable-context-pack requests -> full builder flow. Both paths keep line-cited evidence.

1. Clarify first: if the symptom, environment, comparison point, or expected behavior is ambiguous, present numbered options in chat and wait before launching the builder.
2. Record the investigation question, symptoms, hypotheses, and any user-provided evidence.
3. Load \`skills/context-builder\` (installed as \`rp-mini-context-builder\`) and run it as a Codex native subagent with:
   - task: investigation question plus symptoms and hypotheses
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: \`question\`
   - enhancement mode: \`rewrite\` unless the user requested \`augment\` or \`preserve\`
4. Question loop: this is the rp-build/rp-investigate question loop. If the builder returns \`<questions>\` plus a saved profile name, read the cited files, check git history or searches, and answer only conclusive questions with \`<answer key="..." source="orchestrator" >...</answer>\`. Escalate only for blocking AND high-stakes questions: irreversible/destructive actions, product policy, money/auth/data-loss; present numbered options in chat and wait. Append \`<answers>\` with \`prompt op=append\`, resume with \`manage_selection op=load_profile\`, and remember advisory questions never interrupt.
5. Pursue evidence from the handoff: read selected files, inspect git history or diffs when relevant, and verify claims with file:line references.
6. Refine selection only when evidence shows the builder missed needed context; bias toward adding, not clearing, selection.
7. Finish with a \`workspace_context op=export\` receipt: token totals, content hash, and saved handoff profile. If the caller asked for a durable artifact, write the export to a file with the host Write tool or shell CLI.
8. Report findings as evidence, inference, unknowns, and next recommended action.

Do not change source files in this workflow.
`,
  },
  "rp-plan": {
    description: "Deep planning workflow using rp-mini context-builder.",
    body: `# rp-plan

Use this when the user asks for a plan document before implementation.

Check workspace binding first. On mismatch, pass \`root=<absolute path>\` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use \`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'\` or its wrappers.

1. Clarify first: if goals, constraints, target audience, or involvement level are ambiguous, present numbered options in chat and wait before launching the builder.
2. Create or update \`docs/plans/<topic>-<YYYY-MM-DD>.md\` only after the plan scope is clear.
3. Load \`skills/context-builder\` (installed as \`rp-mini-context-builder\`) and run it as a Codex native subagent with:
   - task: produce architectural planning context for the requested topic
   - budget: 120k default for plan unless caller supplied a hard budget
   - response_type: \`plan\`
   - enhancement mode: \`rewrite\` unless the user requested \`augment\` or \`preserve\`
4. If the builder returns \`<questions>\`, follow the question loop defined in rp-build/rp-investigate before continuing.
5. Act on the handoff: write the plan document in your own concise voice, grounded in selected files and file:line references.
6. Include goal, constraints, architecture, work items, validation, risks, and open questions.
7. Validate non-code quality: internal paths resolve, assumptions are labeled, and the plan matches current repo state.
8. Report the plan path and the key tradeoffs.

Do not implement code in this workflow.
`,
  },
  "rp-refactor": {
    description: "Scoped refactoring workflow using rp-mini context-builder.",
    body: `# rp-refactor

Use this for safe behavior-preserving improvements to code organization, duplication, or complexity.

Check workspace binding first. On mismatch, pass \`root=<absolute path>\` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use \`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'\` or its wrappers.

1. Clarify first: if the target area, behavior-preservation boundary, or acceptable risk is ambiguous, present numbered options in chat and wait before launching the builder.
2. Do a quick scan of the named areas with \`get_file_tree\`, \`file_search\`, or \`get_code_structure\`.
3. Load \`skills/context-builder\` (installed as \`rp-mini-context-builder\`) and run it as a Codex native subagent with:
   - task: analyze the target area for refactoring opportunities while preserving behavior
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: \`review\`
   - enhancement mode: \`rewrite\` unless the user requested \`augment\` or \`preserve\`
4. If the review identifies concrete work, rerun \`context-builder\` with response_type: \`plan\` for the chosen refactor.
5. If the builder returns \`<questions>\`, follow the question loop defined in rp-build/rp-investigate before continuing.
6. Act on the handoff: implement scoped improvements only, one logical change at a time.
7. Validate behavior with existing and targeted tests; broaden tests if shared contracts changed.
8. Report what changed, what stayed intentionally unchanged, validations, and residual risk.

Do not use refactor as a vehicle for unrelated cleanup.
`,
  },
  "rp-review": {
    description: "Code review workflow using rp-mini git context and context-builder.",
    body: `# rp-review

Use this when the user asks for a code review, PR review, diff review, or comparison against another ref.

Check workspace binding first. On mismatch, pass \`root=<absolute path>\` on every rp-mini tool call.
If a shell is available and no MCP client is loaded, use \`node packages/server/dist/cli.js tool <workspace> <tool> --json-args '...'\` or its wrappers.

1. Survey changes with \`git\` status/log/diff and infer comparison scope.
2. Clarify first: if the comparison target is ambiguous or missing, present numbered options in chat and wait before launching the builder.
3. Load \`skills/context-builder\` (installed as \`rp-mini-context-builder\`) and run it as a Codex native subagent with:
   - task: review the confirmed comparison scope, including current branch and key changed files
   - budget: default discovery budget unless caller supplied a hard budget
   - response_type: \`review\`
   - enhancement mode: \`rewrite\` unless the user requested \`augment\` or \`preserve\`
4. If the builder returns \`<questions>\`, follow the question loop defined in rp-build/rp-investigate before continuing.
5. Act on the handoff: review diff context and affected-but-unchanged sources together.
6. Judge correctness, security, API/contracts, tests, maintainability, and consistency with existing patterns.
7. Finish with a \`workspace_context op=export\` receipt: token totals, content hash, and saved handoff profile.
8. Report findings first, ordered by severity, with file:line references and concrete fixes. Keep summary secondary.

Do not provide review feedback before \`context-builder\` has built review-mode context unless the user explicitly requested a quick/manual review.
`,
  },
};

function skillMarkdown(name, description, body) {
  return `---
name: ${name}
description: ${description}
---

${body}`;
}

const toml = `# rp-mini Codex MCP server snippet.
# Merge into ~/.codex/config.toml or run packages/codex-plugin/install.sh --write-config.
# {{RP_MINI_SERVER_CLI}} is resolved to an absolute path by install.sh.
# npx fallback after publishing: npx rp-mini serve
# Equivalent fallback uses command "npx" with args "rp-mini" and "serve".
[mcp_servers.rp-mini]
command = "node"
args = ["{{RP_MINI_SERVER_CLI}}", "serve"]
`;

await mkdir(join(pluginRoot, "skills/context-builder"), { recursive: true });
await writeFile(join(pluginRoot, "skills/context-builder/SKILL.md"), contextBuilder);

for (const [name, definition] of Object.entries(skillDefinitions)) {
  await mkdir(join(pluginRoot, "skills", name), { recursive: true });
  await writeFile(
    join(pluginRoot, "skills", name, "SKILL.md"),
    skillMarkdown(name, definition.description, definition.body),
  );
}

await mkdir(join(pluginRoot, "config"), { recursive: true });
await writeFile(join(pluginRoot, "config/mcp-servers.toml"), toml);
