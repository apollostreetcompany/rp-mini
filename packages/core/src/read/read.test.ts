import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { readFileBatch, readFileSlice } from "./index.js";

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

describe("readFileBatch", () => {
  it("returns valid files in request order and reports invalid paths", async () => {
    const root = await tempRoot("batch");
    await write(join(root, "a.ts"), "a1\na2\na3\n");
    await write(join(root, "b.ts"), "b1\nb2\nb3\n");
    await write(join(root, "c.ts"), "c1\nc2\nc3\n");
    const catalog = await buildCatalog([root], withConfig());
    const byPath = new Map(catalog.roots[0]!.files.map((file) => [file.relativePath, file]));

    const result = await readFileBatch(
      [
        { path: "b.ts", entry: byPath.get("b.ts") },
        { path: "missing.ts" },
        { path: "a.ts", entry: byPath.get("a.ts") },
        { path: "c.ts", entry: byPath.get("c.ts") },
      ],
      { startLine: 2, limit: 1, totalCharBudget: 1000, concurrency: 2 },
    );

    expect(result.invalid_paths).toEqual(["missing.ts"]);
    const files = result.files.filter(
      (file): file is typeof file & { content: string } => "content" in file,
    );
    expect(files.map((file) => [file.path, file.content])).toEqual([
      ["b.ts", "b2\n"],
      ["a.ts", "a2\n"],
      ["c.ts", "c2\n"],
    ]);
    expect(result.limit_hit).toBe(false);
  });

  it("fair-shares a total character budget across batch files", async () => {
    const root = await tempRoot("batch-budget");
    await write(join(root, "a.txt"), `${"a".repeat(40)}\n`);
    await write(join(root, "b.txt"), `${"b".repeat(40)}\n`);
    const catalog = await buildCatalog([root], withConfig());
    const byPath = new Map(catalog.roots[0]!.files.map((file) => [file.relativePath, file]));

    const result = await readFileBatch(
      [
        { path: "a.txt", entry: byPath.get("a.txt") },
        { path: "b.txt", entry: byPath.get("b.txt") },
      ],
      { totalCharBudget: 20, concurrency: 2 },
    );

    expect(result.limit_hit).toBe(true);
    expect(result.omitted_total).toBe(62);
    expect(result.suggestion).toContain("Use fewer paths");
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({
      path: "a.txt",
      content: "aaaaaaaaaa",
      limit_hit: true,
      omitted: 31,
    });
    expect(result.files[1]).toMatchObject({
      path: "b.txt",
      content: "bbbbbbbbbb",
      limit_hit: true,
      omitted: 31,
    });
  });
});
