import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const pluginRoot = join(repoRoot, "packages/codex-plugin");
const contractPath = join(repoRoot, "shared-prompts/discovery/contract.md");
const builderPath = join(pluginRoot, "skills/context-builder/SKILL.md");

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

describe("Codex plugin package", () => {
  it("renders the Codex context-builder skill from the shared discovery contract", () => {
    const contract = readText(contractPath).trim();
    const skill = readText(builderPath);
    const front = frontmatter(skill);

    expect(front.name).toBe("context-builder");
    expect(front.description).toContain("Codex native subagent");
    expect(skill).toContain("<!-- BEGIN GENERATED DISCOVERY CONTRACT -->");
    expect(skill).toContain(contract);
    expect(skill).toContain("<!-- END GENERATED DISCOVERY CONTRACT -->");
  });

  it("keeps load-bearing discovery markers and excludes write tools from builder allowlist", () => {
    const skill = readText(builderPath);
    const availableTools = skill.match(
      /## Available Tools[\s\S]*?## The Selection Is The Universe/,
    );
    expect(availableTools, "Available Tools section").toBeTruthy();

    for (const phrase of [
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
      "do not halt over budget",
    ]) {
      expect(skill).toContain(phrase);
    }

    for (const tag of [
      "<task>",
      "<architecture>",
      "<selected_context>",
      "<relationships>",
      "<ambiguities>",
    ]) {
      expect(skill).toContain(tag);
    }

    expect(availableTools![0]).not.toContain("apply_edits");
    expect(availableTools![0]).not.toContain("file_actions");
  });

  it("defines Codex skills that reference the context-builder skill and numbered clarification", () => {
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
      expect(text).toContain("skills/context-builder");
      expect(text).toContain("native subagent");
      expect(text).toContain("response_type");
      expect(text).toContain("present numbered options in chat and wait");
      expect(text.split("\n").length).toBeLessThanOrEqual(70);
    }
  });

  it("ships a valid mcp_servers TOML snippet pointing at the built CLI", () => {
    const toml = readText(join(pluginRoot, "config/mcp-servers.toml"));

    expect(toml).toContain("[mcp_servers.rp-mini]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["{{RP_MINI_SERVER_CLI}}", "serve"]');
    expect(toml).toContain("npx rp-mini serve");
    expect(existsSync(join(repoRoot, "packages/server/dist/cli.js"))).toBe(true);
  });

  it("passes bash syntax checks and installs/uninstalls idempotently in sandboxed HOME", () => {
    const installScript = join(pluginRoot, "install.sh");
    execFileSync("bash", ["-n", installScript], { cwd: repoRoot });

    const home = mkdtempSync(join(tmpdir(), "rp-mini-codex-home-"));
    try {
      const env = { ...process.env, HOME: home };
      const first = execFileSync("bash", [installScript], { cwd: repoRoot, env, encoding: "utf8" });
      const second = execFileSync("bash", [installScript], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(first).toContain("[mcp_servers.rp-mini]");
      expect(first).not.toContain("{{RP_MINI_SERVER_CLI}}");
      const rendered = first.match(/args = \["([^"]+)", "serve"\]/)?.[1];
      expect(rendered, "rendered CLI path").toBeTruthy();
      expect(existsSync(rendered!), rendered).toBe(true);
      expect(second).toBe(first);

      for (const skill of [
        "context-builder",
        "rp-build",
        "rp-investigate",
        "rp-review",
        "rp-refactor",
        "rp-plan",
        "rp-export",
      ]) {
        expect(existsSync(join(home, ".codex/skills", `rp-mini-${skill}`, "SKILL.md"))).toBe(true);
      }

      execFileSync("bash", [installScript, "--uninstall"], { cwd: repoRoot, env });
      expect(existsSync(join(home, ".codex/skills/rp-mini-rp-build"))).toBe(false);
      expect(existsSync(join(home, ".codex/skills/rp-mini-context-builder"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
