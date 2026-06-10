import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { buildCatalog, getCatalog, isLikelyGenerated, verifyFresh } from "./index.js";

async function tempRoot(name = "catalog"): Promise<string> {
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
  if (overrides.ignore) Object.assign(config.ignore, overrides.ignore);
  return config;
}

describe("buildCatalog", () => {
  it("walks multiple roots and applies universal, gitignore, repo/cursor, and config ignores", async () => {
    const rootA = await tempRoot("root-a");
    const rootB = await tempRoot("root-b");
    await write(join(rootA, ".gitignore"), "*.tmp\nkeep.tmp\n");
    await write(join(rootA, ".repo_ignore"), "repo-only.txt\n");
    await write(join(rootA, ".cursorignore"), "cursor-only.txt\n");
    await write(join(rootA, "src", ".gitignore"), "!keep.tmp\nnested.secret\n");
    await write(join(rootA, "src", "app.ts"), "export const app = 1;\n");
    await write(join(rootA, "src", "drop.tmp"), "ignored\n");
    await write(join(rootA, "src", "keep.tmp"), "kept\n");
    await write(join(rootA, "src", "nested.secret"), "ignored\n");
    await write(join(rootA, "node_modules", "pkg", "index.js"), "ignored\n");
    await write(join(rootA, "repo-only.txt"), "ignored\n");
    await write(join(rootA, "cursor-only.txt"), "ignored\n");
    await write(join(rootA, "vendor", "generated.ts"), "ignored by config\n");
    await write(join(rootB, "other.ts"), "export const other = 2;\n");

    const catalog = await buildCatalog(
      [rootA, rootB],
      withConfig({ ignore: { extra: ["vendor/**"] } }),
    );
    const rootAFiles = catalog.roots[0]!.files.map((file) => file.relativePath).sort();
    const rootBFiles = catalog.roots[1]!.files.map((file) => file.relativePath).sort();

    expect(rootAFiles).toEqual([
      ".cursorignore",
      ".gitignore",
      ".repo_ignore",
      "src/.gitignore",
      "src/app.ts",
      "src/keep.tmp",
    ]);
    expect(rootBFiles).toEqual(["other.ts"]);
    expect(catalog.roots[0]!.ignored).toBeGreaterThanOrEqual(6);
    expect(catalog.roots[0]!.dirs.map((dir) => dir.relativePath)).toContain("src");
  });

  it("auto-applies the iOS ignore preset and keeps xcassets as a single directory node", async () => {
    const root = await tempRoot("ios");
    await write(join(root, "App.xcodeproj", "project.pbxproj"), "ignored\n");
    await write(join(root, "Package.swift"), "// package\n");
    await write(join(root, "Sources", "App.swift"), "struct App {}\n");
    await write(join(root, "Sources", "Info.plist"), "<plist />\n");
    await write(join(root, "Sources", "Main.storyboard"), "<storyboard />\n");
    await write(join(root, "Sources", "View.xib"), "<xib />\n");
    await write(join(root, "Assets.xcassets", "Contents.json"), "{}\n");
    await write(join(root, "Assets.xcassets", "Accent.colorset", "Contents.json"), "{}\n");

    const catalog = await buildCatalog([root], withConfig());
    const files = catalog.roots[0]!.files.map((file) => file.relativePath).sort();
    const dirs = catalog.roots[0]!.dirs.map((dir) => dir.relativePath).sort();

    expect(files).toEqual(["Package.swift", "Sources/App.swift"]);
    expect(dirs).toContain("Assets.xcassets");
    expect(dirs).not.toContain("Assets.xcassets/Accent.colorset");
    expect(dirs).not.toContain("App.xcodeproj");
    expect(catalog.roots[0]!.iosPresetApplied).toBe(true);
  });

  it("does not apply the iOS preset when disabled", async () => {
    const root = await tempRoot("ios-off");
    await write(join(root, "App.xcodeproj", "project.pbxproj"), "kept\n");
    await write(join(root, "Info.plist"), "<plist />\n");

    const catalog = await buildCatalog([root], withConfig({ ignore: { ios_preset: false } }));

    expect(catalog.roots[0]!.files.map((file) => file.relativePath).sort()).toEqual([
      "App.xcodeproj/project.pbxproj",
      "Info.plist",
    ]);
    expect(catalog.roots[0]!.iosPresetApplied).toBe(false);
  });

  it("flags oversized files, binary files, and likely generated files", async () => {
    const root = await tempRoot("flags");
    await write(join(root, "large.txt"), "123456789");
    await write(join(root, "binary.dat"), Buffer.from([1, 2, 0, 4]));
    await write(join(root, "bundle.min.js"), "const a=1;\n");

    const catalog = await buildCatalog([root], withConfig({ caps: { file_size_bytes: 4 } }));
    const byPath = new Map(catalog.roots[0]!.files.map((file) => [file.relativePath, file]));

    expect(byPath.get("large.txt")?.oversized).toBe(true);
    expect(byPath.get("binary.dat")?.isBinary).toBe(true);
    expect(byPath.get("bundle.min.js")?.likelyGenerated).toBe(true);
  });

  it("memoizes getCatalog in-process and verifyFresh detects changed and removed files", async () => {
    const root = await tempRoot("fresh");
    const filePath = join(root, "file.ts");
    await write(filePath, "one\n");

    const first = await getCatalog([root], withConfig());
    const second = await getCatalog([root], withConfig());
    expect(second).toBe(first);

    const entry = first.roots[0]!.files[0]!;
    expect(await verifyFresh(entry)).toEqual({ fresh: true, currentMtimeMs: entry.mtimeMs });

    const current = await stat(filePath);
    const nextTime = new Date(current.mtimeMs + 2000);
    await utimes(filePath, nextTime, nextTime);
    const changed = await verifyFresh(entry);
    expect(changed.fresh).toBe(false);
    expect(changed.currentMtimeMs).not.toBe(entry.mtimeMs);

    await rm(filePath);
    await expect(verifyFresh(entry)).resolves.toEqual({ fresh: false, currentMtimeMs: null });
  });
});

describe("isLikelyGenerated", () => {
  it("matches minified paths, lockfiles, and long-line samples", () => {
    expect(isLikelyGenerated("dist/app.min.js", "const a=1;")).toBe(true);
    expect(isLikelyGenerated("pnpm-lock.yaml", "lockfileVersion: 9")).toBe(true);
    expect(isLikelyGenerated("src/app.ts", `${"x".repeat(320)}\n`)).toBe(true);
    expect(isLikelyGenerated("src/app.ts", "export const app = 1;\n")).toBe(false);
  });
});
