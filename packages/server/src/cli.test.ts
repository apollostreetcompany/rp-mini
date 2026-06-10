import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function tempRoot(): Promise<string> {
  const path = join(tmpdir(), `rp-mini-cli-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

describe("rp-mini index CLI", () => {
  it("prints help with shell wrappers and MCP tool escape hatch", async () => {
    const result = await execFileAsync("node", [
      join(process.cwd(), "packages/server/dist/cli.js"),
      "--help",
    ]);

    expect(result.stdout).toContain("rp-mini search <root> <pattern>");
    expect(result.stdout).toContain("rp-mini read <root> <path>");
    expect(result.stdout).toContain("rp-mini tool <root> <tool-name>");
    expect(result.stdout).toContain("file_search");
    expect(result.stdout).toContain("workspace_context");
  });

  it("prints a root summary and writes a catalog snapshot", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "app.ts"), "export const app = 1;\n");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "ignored\n");
    await mkdir(join(root, ".rp-mini"), { recursive: true });
    await writeFile(join(root, ".rp-mini", "old.json"), "{}\n");

    const first = await execFileAsync(
      "node",
      [join(process.cwd(), "packages/server/dist/cli.js"), "index", root],
      {
        cwd: root,
      },
    );
    const second = await execFileAsync(
      "node",
      [join(process.cwd(), "packages/server/dist/cli.js"), "index", root],
      {
        cwd: root,
      },
    );

    expect(first.stdout).toMatch(
      new RegExp(
        `${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: 1 files, 0 dirs, \\d+ ignored, took \\d+\\.\\d{3}s; codemaps: 0 cached, 1 computed, 0 skipped\\(gated\\)`,
      ),
    );
    expect(second.stdout).toMatch(/codemaps: 1 cached, 0 computed, 0 skipped\(gated\)/);
    const snapshot = JSON.parse(await readFile(join(root, ".rp-mini", "catalog.json"), "utf8")) as {
      roots: Array<{ files: unknown[]; dirs: unknown[] }>;
    };
    expect(snapshot.roots[0]?.files).toHaveLength(1);
    expect(snapshot.roots[0]?.dirs).toHaveLength(0);
  });

  it("warms codemaps for bead 9 languages in a fixture tree", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "View.swift"),
      "import SwiftUI\nstruct ViewModel { let title: String }\n",
    );
    await writeFile(join(root, "Task.java"), 'class Task { String label() { return ""; } }\n');
    await writeFile(
      join(root, "task.c"),
      "#include <stddef.h>\nint add(int a, int b) { return a + b; }\n",
    );
    await writeFile(
      join(root, "task.cpp"),
      "#include <string>\nclass Task { public: std::string label() const; };\n",
    );
    await writeFile(join(root, "Task.cs"), 'class Task { string Label() => ""; }\n');
    await writeFile(join(root, "task.rb"), 'class Task\n  def label\n    ""\n  end\nend\n');
    await writeFile(
      join(root, "task.php"),
      "<?php\nclass Task { public function label(): string { return ''; } }\n",
    );
    await writeFile(join(root, "task.dart"), "class Task { String label() => ''; }\n");

    const result = await execFileAsync(
      "node",
      [join(process.cwd(), "packages/server/dist/cli.js"), "index", root],
      { cwd: root },
    );

    expect(result.stdout).toMatch(/codemaps: 0 cached, 8 computed, 0 skipped\(gated\)/);
  }, 60_000);

  it("exposes search, read, tree, structure, and generic tool wrappers", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "app.ts"),
      [
        "export interface AppConfig {",
        "  name: string;",
        "}",
        "",
        "export function formatApp(config: AppConfig): string {",
        "  return `app:${config.name}`;",
        "}",
        "",
      ].join("\n"),
    );

    const cli = join(process.cwd(), "packages/server/dist/cli.js");
    const search = await execFileAsync("node", [cli, "search", root, "formatApp"], { cwd: root });
    const read = await execFileAsync(
      "node",
      [cli, "read", root, "app.ts", "--start-line", "5", "--limit", "2"],
      { cwd: root },
    );
    const tree = await execFileAsync("node", [cli, "tree", root, "--mode", "full"], { cwd: root });
    const structure = await execFileAsync(
      "node",
      [cli, "structure", root, "app.ts", "--max-results", "1"],
      { cwd: root },
    );
    const tool = await execFileAsync(
      "node",
      [
        cli,
        "tool",
        root,
        "file_search",
        "--json-args",
        JSON.stringify({ pattern: "AppConfig", mode: "both", max_results: 3 }),
      ],
      { cwd: root },
    );

    expect(search.stdout).toContain("app.ts:5:17: formatApp");
    expect(read.stdout).toBe(
      "export function formatApp(config: AppConfig): string {\n  return `app:${config.name}`;\n",
    );
    expect(tree.stdout).toContain("app.ts +");
    expect(structure.stdout).toContain("## app.ts");
    expect(structure.stdout).toContain("formatApp");
    const toolResult = JSON.parse(tool.stdout) as { matches: Array<{ path: string }> };
    expect(toolResult.matches.some((match) => match.path === "app.ts")).toBe(true);
  }, 60_000);

  it("persists selection and prompt state through shell wrappers", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "app.ts"), "export const app = 1;\n");

    const cli = join(process.cwd(), "packages/server/dist/cli.js");
    const session = crypto.randomUUID();
    await execFileAsync(
      "node",
      [cli, "select", root, "set", "app.ts", "--session", session, "--json"],
      { cwd: root },
    );
    await execFileAsync(
      "node",
      [cli, "prompt", root, "set", "Investigate app", "--session", session],
      { cwd: root },
    );
    const context = await execFileAsync(
      "node",
      [cli, "context", root, "snapshot", "--session", session, "--include", "selection,tokens"],
      { cwd: root },
    );

    const snapshot = JSON.parse(context.stdout) as {
      selection: { entries: Array<{ path: string }> };
      total_tokens: number;
    };
    expect(snapshot.selection.entries).toEqual([
      { path: "app.ts", mode: "full", slices: [], auto: false },
    ]);
    expect(snapshot.total_tokens).toBeGreaterThan(0);
  }, 60_000);
});
