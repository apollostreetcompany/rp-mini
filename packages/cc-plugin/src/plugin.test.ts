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
      "Degradation ladder",
      "Pre-halt checklist (MANDATORY)",
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
    ];

    for (const phrase of requiredPhrases) {
      expect(agent).toContain(phrase);
    }
    for (const tag of requiredTags) {
      expect(agent).toContain(tag);
    }
  });

  it("defines thin skills that delegate to the context-builder subagent", () => {
    const skills = [
      "rp-build",
      "rp-investigate",
      "rp-review",
      "rp-refactor",
      "rp-plan",
      "rp-export",
    ];

    for (const skill of skills) {
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
