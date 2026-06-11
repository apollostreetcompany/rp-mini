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

  it("defaults to the full role profile", async () => {
    const rootDir = await tempRoot();

    const config = await loadConfig(rootDir, undefined, { env: {}, homeDir: await tempRoot() });

    expect(config.profile).toBe("full");
  });

  it("merges defaults <- user <- workspace <- env <- per-call overrides", async () => {
    const rootDir = await tempRoot();
    const homeDir = await tempRoot();
    await mkdir(join(homeDir, ".config", "rp-mini"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "rp-mini", "config.json"),
      JSON.stringify({
        profile: "explorer",
        budgets: { discovery: 100 },
        tools: { git: false },
        presets: { custom: { include_files: false } },
      }),
    );
    await writeFile(
      join(rootDir, "rp-mini.config.json"),
      JSON.stringify({
        profile: "editor",
        budgets: { plan: 200 },
        tools: { file_actions: false },
        concurrency: { search_max: 9 },
      }),
    );

    const config = await loadConfig(
      rootDir,
      { profile: "full", budgets: { discovery: 400 }, tools: { apply_edits: false } },
      {
        homeDir,
        env: {
          RP_MINI_PROFILE: "explorer",
          RP_MINI_BUDGETS_PLAN: "300",
          RP_MINI_TOOLS_GIT: "true",
          RP_MINI_DAEMON_KEEP_ALIVE: "true",
          RP_MINI_ROOTS: ".,../other",
        },
      },
    );

    expect(config.budgets).toEqual({ discovery: 400, plan: 300 });
    expect(config.profile).toBe("full");
    expect(config.dynamic_roots).toEqual({ enabled: true, max: 4 });
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
    expect(config.presets.mvp).toBeDefined();
    expect(config.presets.custom).toEqual({ include_files: false });
  });

  it("loads ignore config defaults and overrides", async () => {
    const rootDir = await tempRoot();
    await writeFile(
      join(rootDir, "rp-mini.config.json"),
      JSON.stringify({ ignore: { extra: ["vendor/**"], ios_preset: false } }),
    );

    const config = await loadConfig(rootDir, undefined, { env: {}, homeDir: await tempRoot() });

    expect(defaultConfig.ignore).toEqual({ extra: [], ios_preset: "auto" });
    expect(config.ignore).toEqual({ extra: ["vendor/**"], ios_preset: false });
  });

  it("loads dynamic root config defaults, workspace overrides, env, and per-call overrides", async () => {
    const rootDir = await tempRoot();
    await writeFile(
      join(rootDir, "rp-mini.config.json"),
      JSON.stringify({ dynamic_roots: { enabled: false, max: 2 } }),
    );

    const config = await loadConfig(
      rootDir,
      { dynamic_roots: { max: 6 } },
      {
        env: { RP_MINI_DYNAMIC_ROOTS_ENABLED: "true", RP_MINI_DYNAMIC_ROOTS_MAX: "3" },
        homeDir: await tempRoot(),
      },
    );

    expect(defaultConfig.dynamic_roots).toEqual({ enabled: true, max: 4 });
    expect(config.dynamic_roots).toEqual({ enabled: true, max: 6 });
  });

  it("loads profile from env over workspace config", async () => {
    const rootDir = await tempRoot();
    await writeFile(join(rootDir, "rp-mini.config.json"), JSON.stringify({ profile: "editor" }));

    const config = await loadConfig(rootDir, undefined, {
      env: { RP_MINI_PROFILE: "explorer" },
      homeDir: await tempRoot(),
    });

    expect(config.profile).toBe("explorer");
  });

  it("rejects invalid profile values", async () => {
    const rootDir = await tempRoot();

    await expect(
      loadConfig(rootDir, { profile: "writer" } as never, { env: {}, homeDir: await tempRoot() }),
    ).rejects.toThrow("Invalid profile config: writer");
  });
});
