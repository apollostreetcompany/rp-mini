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
  });
});
