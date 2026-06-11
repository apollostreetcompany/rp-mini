import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { estimateTokens } from "../tokens/index.js";
import { generateFileTree, type FileTreeResult } from "./index.js";

async function tempRoot(name = "tree"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(path: string, content = "x\n"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function withConfig(overrides: DeepPartial<Config> = {}): Config {
  const config = structuredClone(defaultConfig);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  return config;
}

function expectTree(result: ReturnType<typeof generateFileTree>): FileTreeResult {
  if ("error" in result) throw new Error(`Unexpected tree error: ${result.error.code}`);
  return result;
}

function visibleNodeCount(tree: string): number {
  return tree
    .split("\n")
    .filter((line) => line && !line.startsWith("(+ denotes codemap available)")).length;
}

describe("generateFileTree", () => {
  it("renders a deterministic full tree with dirs first, maxDepth, and asset catalog labels", async () => {
    const root = await tempRoot();
    await write(join(root, "b.txt"));
    await write(join(root, "src", "z.ts"));
    await write(join(root, "src", "a.ts"));
    await write(join(root, "Assets.xcassets", "Contents.json"));
    const catalog = await buildCatalog([root], withConfig({ ignore: { ios_preset: false } }));

    const full = expectTree(generateFileTree(catalog, withConfig(), { mode: "full" }));
    expect(full.tree).toContain("Assets.xcassets (asset catalog)");
    expect(full.tree.indexOf("src")).toBeLessThan(full.tree.indexOf("b.txt"));
    expect(full.wasTruncated).toBe(false);

    const shallow = expectTree(
      generateFileTree(catalog, withConfig(), { mode: "full", maxDepth: 0 }),
    );
    expect(shallow.tree).not.toContain("a.ts");
  });

  it("supports folders mode and selected-mode placeholder errors", async () => {
    const root = await tempRoot("folders");
    await write(join(root, "src", "a.ts"));
    const catalog = await buildCatalog([root], withConfig());

    const folders = expectTree(generateFileTree(catalog, withConfig(), { mode: "folders" }));
    expect(folders.tree).toContain("src");
    expect(folders.tree).not.toContain("a.ts");

    expect(generateFileTree(catalog, withConfig(), { mode: "selected" })).toEqual({
      error: { code: "not_available_until_selection" },
    });
  });

  it("auto-trims depth until rendered tree fits the configured token cap", async () => {
    const root = await tempRoot("auto");
    for (let index = 0; index < 80; index += 1) {
      await write(join(root, "src", `very-long-file-name-${index}.ts`));
    }
    const config = withConfig({ caps: { tree_tokens: 35 } });
    const catalog = await buildCatalog([root], config);

    const auto = expectTree(generateFileTree(catalog, config, { mode: "auto" }));
    expect(auto.wasTruncated).toBe(true);
    expect(auto.chosenDepth).toBeDefined();
    expect(estimateTokens(auto.tree)).toBeLessThanOrEqual(config.caps.tree_tokens);
  });

  it("fills at least half of a budget that has deeper same-stage detail available", async () => {
    const root = await tempRoot("budget-fill");
    for (let top = 0; top < 4; top += 1) {
      for (let branch = 0; branch < 4; branch += 1) {
        for (let leaf = 0; leaf < 20; leaf += 1) {
          await write(
            join(
              root,
              `top-${top}`,
              `branch-${branch}`,
              "level-3",
              "level-4",
              `leaf-${leaf}`,
              `file-${leaf}.ts`,
            ),
          );
        }
      }
    }
    const budget = 5_000;
    const config = withConfig({ caps: { tree_tokens: budget } });
    const catalog = await buildCatalog([root], config);

    const auto = expectTree(generateFileTree(catalog, config, { mode: "auto" }));
    const tokens = estimateTokens(auto.tree);

    expect(tokens).toBeLessThanOrEqual(budget);
    expect(tokens).toBeGreaterThanOrEqual(budget * 0.5);
    expect(auto.suggestion).toContain("full tree, distant subtrees summarized at depth 5");
  });

  it("chooses the deepest collapse-distance variant that still fits", async () => {
    const root = await tempRoot("deepest-fit");
    for (let top = 0; top < 2; top += 1) {
      for (let branch = 0; branch < 2; branch += 1) {
        for (let leaf = 0; leaf < 5; leaf += 1) {
          await write(
            join(
              root,
              `top-${top}`,
              `branch-${branch}`,
              "level-3",
              "level-4",
              `leaf-${leaf}`,
              `file-${leaf}.ts`,
            ),
          );
        }
      }
    }
    const budget = 500;
    const config = withConfig({ caps: { tree_tokens: budget } });
    const catalog = await buildCatalog([root], config);

    const auto = expectTree(generateFileTree(catalog, config, { mode: "auto" }));
    const full = expectTree(generateFileTree(catalog, config, { mode: "full" }));

    expect(estimateTokens(auto.tree)).toBeLessThanOrEqual(budget);
    expect(estimateTokens(full.tree)).toBeGreaterThan(budget);
    expect(auto.chosenDepth).toBe(5);
    expect(auto.suggestion).toContain("full tree, distant subtrees summarized at depth 5");
    expect(auto.tree.replace(/rp-mini-deepest-fit-[0-9a-f-]+/, "rp-mini-deepest-fit-<uuid>"))
      .toMatchInlineSnapshot(`
        "(+ denotes codemap available)
        rp-mini-deepest-fit-<uuid>
        ├── top-0/ … (10 files, 16 dirs)
        │   ├── branch-0/ … (5 files, 7 dirs)
        │   │   └── level-3/ … (5 files, 6 dirs)
        │   │       └── level-4/ … (5 files, 5 dirs)
        │   │           ├── leaf-0/ … (1 file)
        │   │           ├── leaf-1/ … (1 file)
        │   │           ├── leaf-2/ … (1 file)
        │   │           ├── leaf-3/ … (1 file)
        │   │           └── leaf-4/ … (1 file)
        │   └── branch-1/ … (5 files, 7 dirs)
        │       └── level-3/ … (5 files, 6 dirs)
        │           └── level-4/ … (5 files, 5 dirs)
        │               ├── leaf-0/ … (1 file)
        │               ├── leaf-1/ … (1 file)
        │               ├── leaf-2/ … (1 file)
        │               ├── leaf-3/ … (1 file)
        │               └── leaf-4/ … (1 file)
        └── top-1/ … (10 files, 16 dirs)
            ├── branch-0/ … (5 files, 7 dirs)
            │   └── level-3/ … (5 files, 6 dirs)
            │       └── level-4/ … (5 files, 5 dirs)
            │           ├── leaf-0/ … (1 file)
            │           ├── leaf-1/ … (1 file)
            │           ├── leaf-2/ … (1 file)
            │           ├── leaf-3/ … (1 file)
            │           └── leaf-4/ … (1 file)
            └── branch-1/ … (5 files, 7 dirs)
                └── level-3/ … (5 files, 6 dirs)
                    └── level-4/ … (5 files, 5 dirs)
                        ├── leaf-0/ … (1 file)
                        ├── leaf-1/ … (1 file)
                        ├── leaf-2/ … (1 file)
                        ├── leaf-3/ … (1 file)
                        └── leaf-4/ … (1 file)
        "
      `);
  });

  it("keeps a generous-budget auto tree byte-identical to full mode", async () => {
    const root = await tempRoot("auto-full");
    await write(join(root, "src", "feature", "handler.ts"));
    await write(join(root, "src", "feature", "model.ts"));
    await write(join(root, "tests", "feature.test.ts"));
    const config = withConfig({ caps: { tree_tokens: 10_000 } });
    const catalog = await buildCatalog([root], config);

    const full = expectTree(generateFileTree(catalog, config, { mode: "full" }));
    const auto = expectTree(generateFileTree(catalog, config, { mode: "auto" }));

    expect(auto.tree).toBe(full.tree);
    expect(auto.limit_hit).toBe(false);
    expect(auto.wasTruncated).toBe(false);
  });

  it("preserves a deep selected anchor and summarizes sibling noise under a tight budget", async () => {
    const root = await tempRoot("anchor");
    await write(join(root, "apps", "web", "src", "auth", "login", "route.ts"));
    await write(join(root, "apps", "web", "src", "auth", "login", "view.ts"));
    for (let index = 0; index < 40; index += 1) {
      await write(join(root, "apps", "web", "src", "feature-noise", `screen-${index}.ts`));
    }
    for (let index = 0; index < 30; index += 1) {
      await write(join(root, "packages", `pkg-${index}`, "index.ts"));
    }
    const config = withConfig({ caps: { tree_tokens: 120 } });
    const catalog = await buildCatalog([root], config);

    const tree = expectTree(
      generateFileTree(catalog, config, {
        mode: "auto",
        selectedPaths: ["apps/web/src/auth/login/route.ts"],
      }),
    );

    expect(estimateTokens(tree.tree)).toBeLessThanOrEqual(config.caps.tree_tokens);
    expect(tree.tree).toContain("apps");
    expect(tree.tree).toContain("web");
    expect(tree.tree).toContain("auth");
    expect(tree.tree).toContain("login");
    expect(tree.tree).toContain("route.ts * +");
    expect(tree.tree).toContain("feature-noise");
    expect(tree.tree).toMatch(/packages\/ \u2026 \(\d+ dirs/);
  });

  it("degrades progressively, keeps root-level coverage, and never drops anchors", async () => {
    const root = await tempRoot("progressive");
    const roots = ["apps", "packages", "services", "tests"];
    for (const top of roots) {
      for (let area = 0; area < 8; area += 1) {
        for (let file = 0; file < 10; file += 1) {
          await write(join(root, top, `area-${area}`, "nested", `file-${file}.ts`));
        }
      }
    }
    const catalog = await buildCatalog([root], withConfig());
    const budgets = [700, 300, 150];
    const selectedPaths = ["services/area-7/nested/file-9.ts"];
    const rendered = budgets.map((budget) =>
      expectTree(
        generateFileTree(catalog, withConfig({ caps: { tree_tokens: budget } }), {
          mode: "auto",
          selectedPaths,
        }),
      ),
    );

    for (const [index, result] of rendered.entries()) {
      expect(estimateTokens(result.tree)).toBeLessThanOrEqual(budgets[index]!);
      for (const top of roots) expect(result.tree).toContain(top);
      expect(result.tree).toContain("services");
      expect(result.tree).toContain("area-7");
      expect(result.tree).toContain("nested");
      expect(result.tree).toContain("file-9.ts * +");
    }
    expect(estimateTokens(rendered[0]!.tree)).toBeGreaterThanOrEqual(
      estimateTokens(rendered[1]!.tree),
    );
    expect(estimateTokens(rendered[1]!.tree)).toBeGreaterThanOrEqual(
      estimateTokens(rendered[2]!.tree),
    );
  });

  it("never shows fewer visible nodes when auto tree budget increases", async () => {
    const root = await tempRoot("monotonic");
    for (const top of ["apps", "packages", "services"]) {
      for (let area = 0; area < 10; area += 1) {
        for (let file = 0; file < 4; file += 1) {
          await write(join(root, top, `area-${area}`, "deep", "leaf", `file-${file}.ts`));
        }
      }
    }
    const catalog = await buildCatalog([root], withConfig());
    const budgets = [400, 1_500, 4_500, 9_000];
    const counts = budgets.map((budget) => {
      const config = withConfig({ caps: { tree_tokens: budget } });
      const tree = expectTree(
        generateFileTree(catalog, config, {
          mode: "auto",
          selectedPaths: ["services/area-9/deep/leaf/file-3.ts"],
        }),
      );
      expect(estimateTokens(tree.tree)).toBeLessThanOrEqual(budget);
      return visibleNodeCount(tree.tree);
    });

    expect(counts[1]).toBeGreaterThanOrEqual(counts[0]!);
    expect(counts[2]).toBeGreaterThanOrEqual(counts[1]!);
    expect(counts[3]).toBeGreaterThanOrEqual(counts[2]!);
  });

  it("renders deterministic auto output for identical inputs", async () => {
    const root = await tempRoot("deterministic");
    for (const path of [
      "src/a/index.ts",
      "src/b/index.ts",
      "src/c/index.ts",
      "tests/a.test.ts",
      "README.md",
    ]) {
      await write(join(root, path));
    }
    const config = withConfig({ caps: { tree_tokens: 75 } });
    const catalog = await buildCatalog([root], config);

    const first = expectTree(
      generateFileTree(catalog, config, { mode: "auto", selectedPaths: ["src/b/index.ts"] }),
    );
    const second = expectTree(
      generateFileTree(catalog, config, { mode: "auto", selectedPaths: ["src/b/index.ts"] }),
    );

    expect(second.tree).toBe(first.tree);
  });

  it("matches golden output for tight selected-anchor degradation", async () => {
    const root = await tempRoot("golden-selected");
    await write(join(root, "src", "auth", "login", "route.ts"));
    await write(join(root, "src", "auth", "logout", "route.ts"));
    await write(join(root, "src", "billing", "invoices", "list.ts"));
    await write(join(root, "src", "billing", "payments", "charge.ts"));
    await write(join(root, "tests", "auth", "login.test.ts"));
    const config = withConfig({ caps: { tree_tokens: 80 } });
    const catalog = await buildCatalog([root], config);

    const tree = expectTree(
      generateFileTree(catalog, config, {
        mode: "auto",
        selectedPaths: ["src/auth/login/route.ts"],
      }),
    ).tree.replace(/rp-mini-golden-selected-[0-9a-f-]+/, "rp-mini-golden-selected-<uuid>");

    expect(tree).toMatchInlineSnapshot(`
      "(+ denotes codemap available)
      rp-mini-golden-selected-<uuid>
      ├── src
      │   ├── auth
      │   │   ├── login
      │   │   │   └── route.ts * +
      │   │   └── logout
      │   └── billing/ … (2 dirs)
      └── tests/ … (1 dir)
      "
    `);
  });

  it("matches golden output for folders-only fallback with selected files shown", async () => {
    const root = await tempRoot("golden-folders");
    for (const top of ["apps", "packages", "tests"]) {
      for (let index = 0; index < 5; index += 1) {
        await write(join(root, top, `module-${index}`, "src", `file-${index}.ts`));
      }
    }
    const config = withConfig({ caps: { tree_tokens: 110 } });
    const catalog = await buildCatalog([root], config);

    const tree = expectTree(
      generateFileTree(catalog, config, {
        mode: "auto",
        selectedPaths: ["packages/module-4/src/file-4.ts"],
      }),
    ).tree.replace(/rp-mini-golden-folders-[0-9a-f-]+/, "rp-mini-golden-folders-<uuid>");

    expect(tree).toMatchInlineSnapshot(`
      "(+ denotes codemap available)
      rp-mini-golden-folders-<uuid>
      ├── apps/ … (10 dirs)
      ├── packages
      │   ├── module-0/ … (1 dir)
      │   ├── module-1/ … (1 dir)
      │   ├── module-2/ … (1 dir)
      │   ├── module-3/ … (1 dir)
      │   └── module-4
      │       └── src
      │           └── file-4.ts * +
      └── tests/ … (10 dirs)
      "
    `);
  });

  it("marks codemap-capable files with + and includes a legend", async () => {
    const root = await tempRoot("codemap-markers");
    await write(join(root, "src", "a.ts"), "export class A {}\n");
    await write(join(root, "src", "a.min.js"), "const x=1;".repeat(500));
    await write(join(root, "README.md"), "# docs\n");
    const catalog = await buildCatalog([root], withConfig());

    const tree = expectTree(generateFileTree(catalog, withConfig(), { mode: "full" }));

    expect(tree.tree).toContain("(+ denotes codemap available)");
    expect(tree.tree).toContain("a.ts +");
    expect(tree.tree).not.toContain("README.md +");
    expect(tree.tree).not.toContain("a.min.js +");
  });
});
