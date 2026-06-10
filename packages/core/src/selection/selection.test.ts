import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { SelectionState, normalizeSlices, subtractSlices, type SelectionSlice } from "./index.js";

async function tempRoot(name = "selection"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function withConfig(overrides: DeepPartial<Config> = {}): Config {
  const config = structuredClone(defaultConfig);
  if (overrides.selection) Object.assign(config.selection, overrides.selection);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  return config;
}

describe("selection slice math", () => {
  it("clamps, sorts, and merges overlapping or adjacent ranges", () => {
    expect(
      normalizeSlices(
        [
          { start: 8, end: 20 },
          { start: -5, end: 3, description: "intro" },
          { start: 4, end: 5 },
          { start: 6, end: 8 },
          { start: 12, end: 10 },
        ],
        10,
      ),
    ).toEqual([{ start: 1, end: 10, description: "intro" }]);
  });

  it("subtracts removal ranges from existing slices", () => {
    const existing: SelectionSlice[] = [
      { start: 1, end: 10, description: "body" },
      { start: 20, end: 25 },
    ];

    expect(subtractSlices(existing, [{ start: 4, end: 22 }])).toEqual([
      { start: 1, end: 3, description: "body" },
      { start: 23, end: 25 },
    ]);
  });
});

describe("SelectionState", () => {
  it("supports set/add/remove, promote, and demote operations", async () => {
    const root = await tempRoot();
    await write(join(root, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
    await write(join(root, "src", "b.ts"), "export const b = 1;\n");
    const config = withConfig({ selection: { auto_codemaps: false, persist: false } });
    const catalog = await buildCatalog([root], config);
    const state = new SelectionState({ root, config, catalog, sessionId: "ops" });

    await state.set([{ path: "src/a.ts", mode: "codemap" }]);
    await state.promote(["src/a.ts"]);
    expect(state.snapshot().entries).toMatchObject([{ path: "src/a.ts", mode: "full" }]);

    await state.demote(["src/a.ts"]);
    expect(state.snapshot().entries).toMatchObject([{ path: "src/a.ts", mode: "codemap" }]);

    await state.add([{ path: "src/a.ts", mode: "slices", slices: [{ start: 2, end: 3 }] }]);
    await state.add([{ path: "src/a.ts", mode: "slices", slices: [{ start: 4, end: 4 }] }]);
    expect(state.snapshot().entries[0]).toMatchObject({
      path: "src/a.ts",
      mode: "slices",
      slices: [{ start: 2, end: 4 }],
    });

    await state.remove([{ path: "src/a.ts", slices: [{ start: 3, end: 3 }] }]);
    expect(state.snapshot().entries[0]).toMatchObject({
      mode: "slices",
      slices: [
        { start: 2, end: 2 },
        { start: 4, end: 4 },
      ],
    });

    await state.add([{ path: "src/b.ts", mode: "full" }]);
    await state.clear();
    expect(state.snapshot().totals.total).toBe(0);
    expect(state.snapshot().entries).toEqual([]);
  });

  it("adds referenced type definitions as auto codemaps without overriding explicit entries", async () => {
    const root = await tempRoot("auto");
    await write(
      join(root, "src", "consumer.ts"),
      "import type { User } from './model';\nexport function show(user: User): string { return user.name; }\n",
    );
    await write(join(root, "src", "model.ts"), "export interface User { name: string }\n");
    const config = withConfig({ selection: { persist: false } });
    const catalog = await buildCatalog([root], config);
    const state = new SelectionState({ root, config, catalog, sessionId: "auto" });

    await state.add([{ path: "src/consumer.ts", mode: "full" }]);
    expect(state.snapshot().autoCodemapPaths).toEqual(["src/model.ts"]);
    expect(state.snapshot().entries.map((entry) => [entry.path, entry.mode])).toEqual([
      ["src/consumer.ts", "full"],
      ["src/model.ts", "codemap"],
    ]);

    await state.add([{ path: "src/model.ts", mode: "full" }]);
    expect(state.snapshot().autoCodemapPaths).toEqual([]);
    expect(state.snapshot().entries.find((entry) => entry.path === "src/model.ts")).toMatchObject({
      mode: "full",
    });
  });

  it("persists session state, profiles, and invalidates stale slices on load", async () => {
    const root = await tempRoot("persist");
    await write(join(root, "src", "a.ts"), "line1\nline2\nline3\n");
    const config = withConfig({ selection: { persist: true, auto_codemaps: false } });
    let catalog = await buildCatalog([root], config);
    const state = new SelectionState({ root, config, catalog, sessionId: "persisted" });

    await state.add([{ path: "src/a.ts", mode: "slices", slices: [{ start: 2, end: 2 }] }]);
    await state.setPrompt("handoff");
    await state.save();
    await state.saveProfile("review");

    const profile = JSON.parse(
      await readFile(join(root, ".rp-mini", "profiles", "review.json"), "utf8"),
    );
    expect(profile.prompt).toBe("handoff");
    expect(await state.listProfiles()).toEqual(["review"]);

    await write(join(root, "src", "a.ts"), "line1\nchanged\nline3\n");
    catalog = await buildCatalog([root], config);
    const reloaded = new SelectionState({ root, config, catalog, sessionId: "persisted" });
    await reloaded.load();

    expect(reloaded.snapshot().entries[0]).toMatchObject({
      path: "src/a.ts",
      mode: "full",
      slices: [],
      slices_invalidated: true,
    });

    const loadedProfile = new SelectionState({ root, config, catalog, sessionId: "profile" });
    await loadedProfile.loadProfile("review");
    expect(loadedProfile.snapshot().prompt).toBe("handoff");
  });

  it("updates token totals by arithmetic delta and matches full recompute", async () => {
    const root = await tempRoot("tokens");
    await write(join(root, "src", "a.ts"), "export const a = 'a';\n");
    await write(join(root, "src", "b.ts"), "export const b = 'b';\n");
    const config = withConfig({ selection: { persist: false, auto_codemaps: false } });
    const catalog = await buildCatalog([root], config);
    const calls: string[] = [];
    const state = new SelectionState({
      root,
      config,
      catalog,
      sessionId: "tokens",
      estimateTokens: (text) => {
        calls.push(text);
        return text.length;
      },
    });

    await state.add([{ path: "src/a.ts", mode: "full" }]);
    const afterA = calls.length;
    await state.add([{ path: "src/b.ts", mode: "full" }]);

    expect(calls.length).toBeGreaterThan(afterA);
    expect(calls.length - afterA).toBeLessThanOrEqual(2);
    expect(state.snapshot().totals.total).toBe(await state.recomputeTokenTotalForTest());
  });
});
