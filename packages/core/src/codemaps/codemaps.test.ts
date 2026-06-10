import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { rankSearchResults } from "../search/index.js";
import {
  buildTypeIndex,
  canCodemapFile,
  getCodeStructures,
  lookupDefiningFiles,
  serializeFileApi,
  warmCodemapCache,
} from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function tempRoot(name = "codemap"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function copyFixture(root: string, fixture: string, target: string): Promise<void> {
  const content = await readFile(join(fixturesDir, fixture), "utf8");
  await write(root, target, content);
}

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function withConfig(overrides: DeepPartial<Config> = {}): Config {
  const config = structuredClone(defaultConfig);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  if (overrides.codemaps) Object.assign(config.codemaps, overrides.codemaps);
  if (overrides.concurrency) Object.assign(config.concurrency, overrides.concurrency);
  return config;
}

describe("codemaps", () => {
  it.each([
    ["ts-smoke.ts", "src/smoke.ts", ["UserCardModel", "UserCardProps", "formatUser"]],
    ["tsx-component.tsx", "src/component.tsx", ["ButtonProps", "Button", "Toolbar"]],
    ["js-smoke.js", "src/smoke.js", ["TaskStore", "normalizeTask", "createTask"]],
    ["py-smoke.py", "src/smoke.py", ["Worker", "Status", "build_worker"]],
    ["go-smoke.go", "src/smoke.go", ["Worker", "Run", "NewWorker"]],
    ["rs-smoke.rs", "src/smoke.rs", ["Task", "new", "default_task"]],
    // Fixture shape adapted from CE CodeMap fixtures/goldens.
    ["swift-smoke.swift", "src/smoke.swift", ["FriendlyGreeter", "Greeter", "makeGreeter"]],
    ["java-smoke.java", "src/smoke.java", ["Task", "TaskRepository", "TaskStatus", "load"]],
    ["c-smoke.c", "src/smoke.c", ["Task", "TaskStatus", "TaskCount", "add"]],
    ["cpp-smoke.cpp", "src/smoke.cpp", ["Task", "TaskService", "TaskStatus", "draft"]],
    ["csharp-smoke.cs", "src/smoke.cs", ["Task", "ITaskRepository", "TaskStatus", "Rename"]],
    ["ruby-smoke.rb", "src/smoke.rb", ["Task", "TaskFormatting", "build_task", "rename"]],
    ["php-smoke.php", "src/smoke.php", ["Task", "TaskRepository", "HasTaskTitle", "task_label"]],
    ["dart-smoke.dart", "src/smoke.dart", ["Task", "TaskRepository", "TaskStatus", "makeTask"]],
  ])("extracts structure from %s", async (fixture, target, expectedNames) => {
    const root = await tempRoot(basename(fixture));
    await copyFixture(root, fixture, target);
    const catalog = await buildCatalog([root], withConfig());

    const result = await getCodeStructures(catalog, withConfig(), { paths: [target] });

    expect(result.files).toHaveLength(1);
    const text = result.files[0]!.text;
    expect(text).toContain(`File: ${target}`);
    for (const name of expectedNames) expect(text).toContain(name);
    expect(result.limit_hit).toBe(false);
  });

  it("renders SwiftUI property wrappers, body marker, and preview count", async () => {
    const root = await tempRoot("swiftui");
    await copyFixture(root, "swiftui-view.swift", "Sources/App/CounterView.swift");
    const catalog = await buildCatalog([root], withConfig());

    const result = await getCodeStructures(catalog, withConfig(), {
      paths: ["Sources/App/CounterView.swift"],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.text).toContain("Previews: 2");
    expect(result.files[0]!.text).toContain("CounterModel");
    expect(result.files[0]!.text).not.toContain("  - Observable");
    expect(result.files[0]!.text).toContain("View body");
    expect(result.files[0]!.text).toContain("@State private var count: Int");
    expect(result.files[0]!.text).toContain("@Binding var title: String");
    expect(result.files[0]!.text).toContain("@Environment(\\.colorScheme) private var colorScheme");
    expect(result.files[0]!.text).toContain("@StateObject private var store");
    expect(result.files[0]!.text).toContain("@ObservedObject var legacy: LegacyStore");
    expect(result.files[0]!.text).toContain("@Published var isReady: Bool");
  });

  it("renders a compact Package.swift dependency surface", async () => {
    const root = await tempRoot("package-swift");
    await copyFixture(root, "Package.swift", "Package.swift");
    const catalog = await buildCatalog([root], withConfig());

    const result = await getCodeStructures(catalog, withConfig(), { paths: ["Package.swift"] });

    expect(result.files).toHaveLength(1);
    const text = result.files[0]!.text;
    expect(text).toContain("Package:");
    expect(text).toContain("name: CounterKit");
    expect(text).toContain("Products:");
    expect(text).toContain("library CounterKit");
    expect(text).toContain("executable CounterTool");
    expect(text).toContain("Dependencies:");
    expect(text).toContain("swift-argument-parser");
    expect(text).toContain("Targets:");
    expect(text).toContain("target CounterKit");
    expect(text).toContain("executableTarget CounterTool");
    expect(text).toContain("testTarget CounterKitTests");
  });

  it("maps bead 9 extensions to codemap languages", async () => {
    const root = await tempRoot("extensions");
    const files = [
      "App.swift",
      "Task.java",
      "task.c",
      "task.h",
      "task.cpp",
      "task.cc",
      "task.hpp",
      "Task.cs",
      "task.rb",
      "task.php",
      "task.dart",
    ];
    for (const file of files) await write(root, file, "placeholder\n");
    const catalog = await buildCatalog([root], withConfig());

    const codemapTargets = catalog.roots[0]!.files.filter((file) =>
      canCodemapFile(file, withConfig()),
    )
      .map((file) => file.relativePath)
      .sort();

    expect(codemapTargets).toEqual(files.sort());
  });

  it("gracefully skips files whose language is not enabled", async () => {
    const root = await tempRoot("disabled-language");
    await copyFixture(root, "swift-smoke.swift", "src/smoke.swift");
    const config = withConfig({ codemaps: { languages: ["ts"] } });
    const catalog = await buildCatalog([root], config);

    const result = await getCodeStructures(catalog, config, { paths: ["src/smoke.swift"] });

    expect(result.files).toHaveLength(0);
    expect(result.limit_hit).toBe(true);
    expect(result.omitted_total).toBe(1);
  });

  it("serializes CE-compatible sections and truncates long member lists", async () => {
    const api = {
      filePath: "src/many.ts",
      imports: ['import { A } from "./a";'],
      exports: ["export class Many {"],
      classes: [
        {
          name: "Many",
          methods: Array.from({ length: 80 }, (_, index) => ({
            name: `m${index}`,
            definitionLine: `m${index}(): void`,
            lineNumber: index + 1,
          })),
          properties: [],
        },
      ],
      interfaces: [],
      aliases: [],
      literalUnions: [],
      functions: [],
      enums: [],
      globalVars: [],
      macros: [],
      referencedTypes: [],
      definedTypeNames: ["Many"],
    };

    const text = serializeFileApi(api, { maxTokens: 120 });

    expect(text).toMatch(/^File: src\/many\.ts\nImports:/);
    expect(text).toContain("Classes:");
    expect(text).toContain("... (+");
    expect(text).toContain("Exports:");
  });

  it("uses sha cache hits and invalidates when content changes", async () => {
    const root = await tempRoot("cache");
    await copyFixture(root, "ts-smoke.ts", "src/smoke.ts");
    let catalog = await buildCatalog([root], withConfig());

    const first = await warmCodemapCache(catalog, withConfig());
    expect(first).toMatchObject({ computed: 1, cached: 0, skipped: 0 });

    catalog = await buildCatalog([root], withConfig());
    const second = await warmCodemapCache(catalog, withConfig());
    expect(second).toMatchObject({ computed: 0, cached: 1, skipped: 0 });

    await write(
      root,
      "src/smoke.ts",
      `${await readFile(join(root, "src/smoke.ts"), "utf8")}\nexport const Later = 1;\n`,
    );
    catalog = await buildCatalog([root], withConfig());
    const third = await warmCodemapCache(catalog, withConfig());
    expect(third).toMatchObject({ computed: 1, cached: 0, skipped: 0 });
  });

  it("gates generated files but not large source files", async () => {
    const root = await tempRoot("gating");
    await write(root, "src/app.ts", "export const value = 1;\n".repeat(2000));
    await write(root, "src/app.min.js", "const x=1;".repeat(500));
    const config = withConfig({ caps: { file_size_bytes: 10 } });
    const catalog = await buildCatalog([root], config);
    const source = catalog.roots[0]!.files.find((file) => file.relativePath === "src/app.ts")!;
    const generated = catalog.roots[0]!.files.find(
      (file) => file.relativePath === "src/app.min.js",
    )!;

    expect(source.oversized).toBe(true);
    expect(canCodemapFile(source, config)).toBe(true);
    expect(canCodemapFile(generated, config)).toBe(false);
  });

  it("builds a type index and boosts definition matches in search ranking", async () => {
    const root = await tempRoot("type-index");
    await copyFixture(root, "ts-smoke.ts", "src/model.ts");
    await write(root, "src/usage.ts", "const model: UserCardModel | undefined = undefined;\n");
    const catalog = await buildCatalog([root], withConfig());
    await warmCodemapCache(catalog, withConfig());
    const index = await buildTypeIndex(catalog, withConfig());

    expect(lookupDefiningFiles(index, "UserCardModel")).toEqual(["src/model.ts"]);
    const ranked = rankSearchResults(
      [
        { path: "src/usage.ts", matchText: "UserCardModel", line: 1 },
        { path: "src/model.ts", matchText: "UserCardModel", line: 9 },
      ],
      { symbolIndex: index },
    );
    expect(ranked[0]?.path).toBe("src/model.ts");
  });

  it("expands directories and enforces the structure response cap", async () => {
    const root = await tempRoot("cap");
    for (let index = 0; index < 8; index += 1) {
      await copyFixture(root, "ts-smoke.ts", `src/smoke-${index}.ts`);
    }
    const catalog = await buildCatalog([root], withConfig());

    const result = await getCodeStructures(
      catalog,
      withConfig({ caps: { structure_tokens: 180 } }),
      {
        paths: ["src"],
        maxResults: 20,
      },
    );

    expect(result.files.length).toBeGreaterThan(0);
    expect(result.limit_hit).toBe(true);
    expect(result.omitted_total).toBeGreaterThan(0);
    expect(result.suggestion).toContain("Narrow");
  });

  it("writes cache files under the configured codemap cache directory", async () => {
    const root = await tempRoot("cache-dir");
    await copyFixture(root, "go-smoke.go", "src/smoke.go");
    const catalog = await buildCatalog([root], withConfig());

    await warmCodemapCache(catalog, withConfig());
    const cacheDir = join(root, ".rp-mini", "codemap-cache");
    const info = await stat(cacheDir);

    expect(info.isDirectory()).toBe(true);
  });
});
