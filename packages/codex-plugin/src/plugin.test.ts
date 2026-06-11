import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  const rpSkills = [
    "rp-build",
    "rp-investigate",
    "rp-review",
    "rp-refactor",
    "rp-plan",
    "rp-export",
  ];

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
      "<questions>",
    ]) {
      expect(skill).toContain(tag);
    }

    expect(availableTools![0]).not.toContain("apply_edits");
    expect(availableTools![0]).not.toContain("file_actions");
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

  it("defines Codex skills that reference the context-builder skill and numbered clarification", () => {
    for (const skill of rpSkills) {
      const text = readText(join(pluginRoot, `skills/${skill}/SKILL.md`));
      const front = frontmatter(text);
      expect(front.name).toBe(skill);
      expect(front.description.length).toBeGreaterThan(10);
      expect(text).toContain("skills/context-builder");
      expect(text).toContain("native subagent");
      expect(text).toContain("response_type");
      expect(text).toContain("present numbered options in chat and wait");
      expect(text.split("\n").length).toBeLessThanOrEqual(90);
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
        "present numbered options in chat and wait",
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
    expect(statSync(installScript).mode & 0o111).toBeGreaterThan(0);

    const home = mkdtempSync(join(tmpdir(), "rp-mini-codex-home-"));
    try {
      const env = { ...process.env, HOME: home };
      const first = execFileSync(installScript, [], { cwd: repoRoot, env, encoding: "utf8" });
      const second = execFileSync(installScript, [], {
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

      execFileSync(installScript, ["--uninstall"], { cwd: repoRoot, env });
      expect(existsSync(join(home, ".codex/skills/rp-mini-rp-build"))).toBe(false);
      expect(existsSync(join(home, ".codex/skills/rp-mini-context-builder"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
