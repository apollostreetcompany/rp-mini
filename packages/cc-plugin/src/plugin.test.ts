import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const pluginRoot = join(repoRoot, "packages/cc-plugin");
const contractPath = join(repoRoot, "shared-prompts/discovery/contract.md");
const agentPath = join(pluginRoot, "agents/context-builder.md");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, "frontmatter block").toBeTruthy();
  const result: Record<string, string> = {};
  for (const line of match![1].split("\n")) {
    const [key, ...rest] = line.split(":");
    result[key.trim()] = rest.join(":").trim();
  }
  return result;
}

function listValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

describe("Claude Code plugin package", () => {
  const rpSkills = [
    "rp-build",
    "rp-investigate",
    "rp-review",
    "rp-refactor",
    "rp-plan",
    "rp-export",
  ];

  it("declares a valid plugin manifest", () => {
    const manifest = readJson(join(pluginRoot, ".claude-plugin/plugin.json")) as {
      name?: string;
      description?: string;
      version?: string;
      author?: string;
    };

    expect(manifest.name).toBe("rp-mini");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toContain("Claude Code");
    expect(manifest.author).toBeTruthy();
  });

  it("configures the rp-mini MCP server with an existing built CLI path", () => {
    const mcp = readJson(join(pluginRoot, ".mcp.json")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const server = mcp.mcpServers?.["rp-mini"];

    expect(server?.command).toBe("node");
    expect(server?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/../server/dist/cli.js", "serve"]);

    const cliPath = server!.args![0].replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
    expect(existsSync(cliPath), cliPath).toBe(true);
  });

  it("renders the context-builder agent from the shared discovery contract", () => {
    const contract = readText(contractPath).trim();
    const agent = readText(agentPath);
    const front = frontmatter(agent);
    const allowedTools = [
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

    expect(front.name).toBe("context-builder");
    expect(front.description).toContain("autonomous context curation");
    expect(front.model).toBe("inherit");
    expect(listValue(front.tools)).toEqual(allowedTools);

    expect(agent).toContain("<!-- BEGIN GENERATED DISCOVERY CONTRACT -->");
    expect(agent).toContain(contract);
    expect(agent).toContain("<!-- END GENERATED DISCOVERY CONTRACT -->");
  });

  it("keeps load-bearing discovery contract markers in the rendered agent", () => {
    const agent = readText(agentPath);
    const requiredPhrases = [
      '<taskname="',
      "<questions>",
      '<question key="migration-backfill" severity="blocking" default="separate-job">',
      '<option value="inline">Backfill in the same migration</option>',
      "<answers>",
      '<answer key="migration-backfill" source="orchestrator|user">separate-job</answer>',
      "Workspace Binding",
      'root="<absolute path>"',
      "get_file_tree mode=folders max_depth=1",
      "Degradation ladder",
      "Pre-halt checklist (MANDATORY)",
      'manage_selection op=save_profile name="handoff-<short-task-slug>"',
      "manage_selection op=load_profile",
      "state the profile name and final token total",
      "FINAL GATE",
      "rewrite",
      "augment",
      "preserve",
      "response_type=plan",
      "response_type=question",
      "response_type=review",
      "response_type=clarify",
      "git op=diff",
      "do not halt over budget",
    ];
    const requiredTags = [
      "<task>",
      "<architecture>",
      "<selected_context>",
      "<relationships>",
      "<ambiguities>",
      "<questions>",
    ];

    for (const phrase of requiredPhrases) {
      expect(agent).toContain(phrase);
    }
    for (const tag of requiredTags) {
      expect(agent).toContain(tag);
    }
  });

  it("documents selection-profile handoff and workspace binding in the shared contract", () => {
    const contract = readText(contractPath);

    expect(contract).toContain("## Workspace Binding");
    expect(contract).toContain("get_file_tree mode=folders max_depth=1");
    expect(contract).toContain('root="<absolute path>"');
    expect(contract).toContain('manage_selection op=save_profile name="handoff-<short-task-slug>"');
    expect(contract).toContain("manage_selection op=load_profile");
    expect(contract).toContain("final token total");
  });

  it("documents the question-loop contract and resume semantics", () => {
    const contract = readText(contractPath);

    for (const phrase of [
      "## Question Loop",
      "<questions>",
      "<answers>",
      'severity="blocking"',
      'severity="advisory"',
      "keys are stable kebab-case",
      "Every question carries a `default`",
      "evidence pointers",
      "complete the best selection you can and save the handoff profile before halting",
      "questions never excuse an empty selection",
      "Advisory questions never block",
      "If `<answers>` are present, treat them as binding decisions",
      "do not re-ask answered keys",
      "Unanswered advisory keys",
      "proceed with defaults",
    ]) {
      expect(contract).toContain(phrase);
    }
  });

  it("defines thin skills that delegate to the context-builder subagent", () => {
    for (const skill of rpSkills) {
      const text = readText(join(pluginRoot, `skills/${skill}/SKILL.md`));
      const front = frontmatter(text);
      expect(front.name).toBe(skill);
      expect(front.description.length).toBeGreaterThan(10);
      expect(text).toContain("AskUserQuestion");
      expect(text).toContain("context-builder");
      expect(text).toContain("response_type");
      expect(text.split("\n").length).toBeLessThanOrEqual(60);
    }
  });

  it("documents the orchestrator question loop in rp-build and rp-investigate", () => {
    for (const skill of ["rp-build", "rp-investigate"]) {
      const text = readText(join(pluginRoot, `skills/${skill}/SKILL.md`));
      for (const phrase of [
        "Question loop",
        "saved profile name",
        "read the cited files",
        "git history",
        'source="orchestrator"',
        "blocking AND high-stakes",
        "irreversible/destructive actions, product policy, money/auth/data-loss",
        "AskUserQuestion",
        "prompt op=append",
        "<answers>",
        "manage_selection op=load_profile",
        "advisory questions never interrupt",
      ]) {
        expect(text).toContain(phrase);
      }
    }
  });

  it("references the question loop from every rp-* skill", () => {
    for (const skill of rpSkills) {
      const text = readText(join(pluginRoot, `skills/${skill}/SKILL.md`));
      expect(text).toContain("question loop");
      expect(text).toContain("rp-build/rp-investigate");
    }
  });

  it("keeps workspace binding and shell CLI fallback notes in every rp-* skill", () => {
    for (const skill of rpSkills) {
      const text = readText(join(pluginRoot, `skills/${skill}/SKILL.md`));
      expect(text).toContain("Check workspace binding first");
      expect(text).toContain("root=<absolute path>");
      expect(text).toContain(
        "node packages/server/dist/cli.js tool <workspace> <tool> --json-args",
      );
    }
  });

  it("adds investigation triage fast path and export receipts where required", () => {
    const investigate = readText(join(pluginRoot, "skills/rp-investigate/SKILL.md"));
    expect(investigate).toContain("Triage fast path");
    expect(investigate).toContain("Bounded question");
    expect(investigate).toContain("do not spawn the builder");
    expect(investigate).toContain("file_search");
    expect(investigate).toContain("read_file");
    expect(investigate).toContain("get_code_structure");
    expect(investigate).toContain("line-cited evidence");

    for (const skill of ["rp-investigate", "rp-review", "rp-export"]) {
      const text = readText(join(pluginRoot, `skills/${skill}/SKILL.md`));
      expect(text).toContain("workspace_context op=export");
      expect(text).toContain("token totals");
      expect(text).toContain("content hash");
      expect(text).toContain("saved handoff profile");
    }
  });

  it("defines a SessionStart warm hook that is optional and backgrounded", () => {
    const hooks = readJson(join(pluginRoot, "hooks/hooks.json")) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> };
    };
    const command = hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;

    expect(hooks.hooks?.SessionStart).toHaveLength(1);
    expect(command).toContain("packages/server/dist/cli.js");
    expect(command).toContain("index .");
    expect(command).toContain("&");
  });
});
