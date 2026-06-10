import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { readFileSlice } from "./index.js";

async function tempRoot(name = "read"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(path: string, content: string | Buffer): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function withConfig(overrides: DeepPartial<Config> = {}): Config {
  const config = structuredClone(defaultConfig);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  return config;
}

describe("readFileSlice", () => {
  it("returns positive ranges, tail ranges, and total line metadata", async () => {
    const root = await tempRoot();
    await write(join(root, "file.ts"), "one\ntwo\nthree\nfour\nfive\n");
    const catalog = await buildCatalog([root], withConfig());
    const entry = catalog.roots[0]!.files[0]!;

    await expect(readFileSlice(entry, { startLine: 2, limit: 2 })).resolves.toEqual({
      content: "two\nthree\n",
      totalLines: 5,
      firstLine: 2,
      lastLine: 3,
    });
    await expect(readFileSlice(entry, { startLine: -2 })).resolves.toEqual({
      content: "four\nfive\n",
      totalLines: 5,
      firstLine: 4,
      lastLine: 5,
    });
  });

  it("refuses binary and oversized catalog entries with structured errors", async () => {
    const root = await tempRoot("refuse");
    await write(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    await write(join(root, "large.txt"), "123456789\n");
    const catalog = await buildCatalog([root], withConfig({ caps: { file_size_bytes: 4 } }));
    const byPath = new Map(catalog.roots[0]!.files.map((file) => [file.relativePath, file]));

    await expect(readFileSlice(byPath.get("binary.dat")!, {})).resolves.toMatchObject({
      error: { code: "binary" },
    });
    await expect(readFileSlice(byPath.get("large.txt")!, {})).resolves.toMatchObject({
      error: { code: "too_large" },
    });
  });

  it("re-stats and reads current content when catalog mtime is stale", async () => {
    const root = await tempRoot("fresh");
    const file = join(root, "file.ts");
    await write(file, "old\n");
    const catalog = await buildCatalog([root], withConfig());
    await write(file, "new\n");

    await expect(readFileSlice(catalog.roots[0]!.files[0]!, {})).resolves.toMatchObject({
      content: "new\n",
      totalLines: 1,
    });
  });
});
