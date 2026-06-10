import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "./index.js";

async function tempRoot(): Promise<string> {
  const path = join(tmpdir(), `rp-mini-config-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

describe("loadConfig", () => {
  it("returns the full default config object", async () => {
    const rootDir = await tempRoot();

    await expect(
      loadConfig(rootDir, undefined, { env: {}, homeDir: await tempRoot() }),
    ).resolves.toEqual(defaultConfig);
  });

  it("merges defaults <- user <- workspace <- env <- per-call overrides", async () => {
    const rootDir = await tempRoot();
    const homeDir = await tempRoot();
    await mkdir(join(homeDir, ".config", "rp-mini"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "rp-mini", "config.json"),
      JSON.stringify({
        budgets: { discovery: 100 },
        tools: { git: false },
        presets: { custom: { include_files: false } },
      }),
    );
    await writeFile(
      join(rootDir, "rp-mini.config.json"),
      JSON.stringify({
        budgets: { plan: 200 },
        tools: { file_actions: false },
        concurrency: { search_max: 9 },
      }),
    );

    const config = await loadConfig(
      rootDir,
      { budgets: { discovery: 400 }, tools: { apply_edits: false } },
      {
        homeDir,
        env: {
          RP_MINI_BUDGETS_PLAN: "300",
          RP_MINI_TOOLS_GIT: "true",
          RP_MINI_DAEMON_KEEP_ALIVE: "true",
          RP_MINI_ROOTS: ".,../other",
        },
      },
    );

    expect(config.budgets).toEqual({ discovery: 400, plan: 300 });
    expect(config.tools).toMatchObject({
      apply_edits: false,
      file_actions: false,
      git: true,
    });
    expect(config.concurrency.search_max).toBe(9);
    expect(config.daemon.keep_alive).toBe(true);
    expect(config.roots).toEqual([".", "../other"]);
    expect(config.presets.standard).toBeDefined();
    expect(config.presets.plan).toBeDefined();
    expect(config.presets.review).toBeDefined();
    expect(config.presets["diff-followup"]).toBeDefined();
    expect(config.presets.custom).toEqual({ include_files: false });
  });
});
