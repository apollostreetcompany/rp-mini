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
