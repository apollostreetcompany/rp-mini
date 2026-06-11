#!/usr/bin/env node
import {
  assemblePayload,
  atomicWriteJson,
  buildCatalog,
  cacheDir,
  defaultConfig,
  loadConfig,
  searchFiles,
  SelectionState,
  estimateTokens,
  generateFileTree,
  warmCodemapCache,
  getCodeStructures,
} from "../packages/core/dist/index.js";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve, relative } from "node:path";

const RUNS = 3;
const root = resolve(process.cwd());
const cli = parseArgs(process.argv.slice(2));
const corpusArg = cli.positionals[0];
const corpusSource = resolve(root, corpusArg ?? "../repoprompt-ce");
const dateArg = cli.date ?? process.env.RP_MINI_BENCH_DATE;
const measuredAt = dateArg ?? new Date().toISOString().slice(0, 10);
const docsPath = join(root, "docs", "bench.md");

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  await assertBuilt();
  const benchRoot = await prepareCorpusCopy(corpusSource);
  const configHome = await mkdtemp(join(os.tmpdir(), "rp-mini-bench-home-"));
  const config = await loadConfig(
    benchRoot,
    {
      roots: [benchRoot],
      selection: { persist: false },
      codemaps: { cache_dir: defaultConfig.codemaps.cache_dir },
    },
    { homeDir: configHome },
  );

  const coldIndex = await medianMeasure(async () => {
    await rm(join(benchRoot, ".rp-mini", "catalog.json"), { force: true });
    return buildCatalog([benchRoot], config);
  });
  const catalog = coldIndex.value;
  const stats = corpusStats(catalog);

  const coldCodemap = await medianMeasure(async () => {
    await rm(join(benchRoot, ".rp-mini", "codemap-cache"), { force: true, recursive: true });
    const freshCatalog = await buildCatalog([benchRoot], config);
    return warmCodemapCache(freshCatalog, config);
  });

  await warmCodemapCache(catalog, config);
  const warmIndex = await medianMeasure(async () => {
    const freshCatalog = await buildCatalog([benchRoot], config);
    const codemaps = await warmCodemapCache(freshCatalog, config);
    await atomicWriteJson(join(cacheDir(benchRoot), "catalog.json"), freshCatalog);
    return codemaps;
  });

  const contentQueries = ["CodeMap", "MCPFilesystemIdentity", "TreeSitter"];
  const contentResults = [];
  for (const pattern of contentQueries) {
    contentResults.push({
      pattern,
      ...(await medianMeasure(() =>
        searchFiles(catalog, config, { pattern, mode: "content", max_results: 25 }),
      )),
    });
  }
  const pathSearch = await medianMeasure(() =>
    searchFiles(catalog, config, { pattern: "package", mode: "path", max_results: 25 }),
  );

  const structureDir = directoryWithCodemapFiles(catalog, 10);
  const structure = await medianMeasure(() =>
    getCodeStructures(catalog, config, { paths: [structureDir], maxResults: 10 }),
  );

  const selectedFiles = firstTextFiles(catalog, 20);
  const treeAnchorFiles = spreadTextFiles(catalog, 10);
  const treeBudgets = [2000, 5000, 10000];
  const treeRows = [];
  for (const budget of treeBudgets) {
    const treeConfig = { ...config, caps: { ...config.caps, tree_tokens: budget } };
    const measurement = await medianMeasure(() =>
      generateFileTree(catalog, treeConfig, {
        mode: "auto",
        maxTokens: budget,
        selectedPaths: treeAnchorFiles,
      }),
    );
    const tree = "tree" in measurement.value ? measurement.value.tree : "";
    const tokens = estimateTokens(tree);
    const anchorRetention = anchorRetentionStats(tree, treeAnchorFiles);
    const topCoverage = topLevelCoverageStats(tree, catalog);
    treeRows.push([
      `${budget}`,
      formatMs(measurement.ms),
      `${tokens}/${budget}`,
      `${anchorRetention.visible}/${anchorRetention.total} (${formatPercent(anchorRetention.visible / anchorRetention.total)})`,
      `${topCoverage.visible}/${topCoverage.total} (${formatPercent(topCoverage.visible / topCoverage.total)})`,
    ]);
  }
  const workspaceExport = await medianMeasure(async () => {
    const state = new SelectionState({
      root: benchRoot,
      config,
      catalog,
      sessionId: `bench-${crypto.randomUUID()}`,
    });
    await state.set(selectedFiles.map((path) => ({ path, mode: "full" })));
    await state.setPrompt("Benchmark export payload.");
    const snapshot = state.snapshot();
    const payload = await assemblePayload(snapshot, config, {
      root: benchRoot,
      catalog,
      preset: "standard",
      now: () => new Date(`${measuredAt}T00:00:00.000Z`),
    });
    const base = join(benchRoot, ".rp-mini", "exports", `${payload.contentHash.slice(0, 12)}`);
    await mkdir(dirname(base), { recursive: true });
    await writeFile(`${base}.md`, payload.text, "utf8");
    await atomicWriteJson(`${base}.json`, {
      content_hash: payload.contentHash,
      tokens: payload.tokenBreakdown,
      files: snapshot.entries.length,
    });
    return payload;
  });

  const rows = [
    ["Cold catalog index", formatMs(coldIndex.ms), `${stats.files} files, ${stats.dirs} dirs`],
    [
      "Cold codemap warm",
      formatMs(coldCodemap.ms),
      `${coldCodemap.value.computed} computed, ${coldCodemap.value.cached} cached, ${filesPerSecond(
        coldCodemap.value.computed,
        coldCodemap.ms,
      )} files/sec`,
    ],
    [
      "Warm cached index",
      formatMs(warmIndex.ms),
      `${warmIndex.value.cached} cached, ${warmIndex.value.computed} computed`,
    ],
    ...contentResults.map((result) => [
      `file_search content '${result.pattern}'`,
      formatMs(result.ms),
      `${result.value.matches.length} matches, limit_hit=${result.value.limit_hit}`,
    ]),
    [
      "file_search path 'package'",
      formatMs(pathSearch.ms),
      `${pathSearch.value.matches.length} matches, limit_hit=${pathSearch.value.limit_hit}`,
    ],
    [
      `get_code_structure ${structureDir}`,
      formatMs(structure.ms),
      `${structure.value.files.length} files, omitted=${structure.value.omitted_total}`,
    ],
    [
      "workspace_context export 20 files",
      formatMs(workspaceExport.ms),
      `${workspaceExport.value.tokenBreakdown.total} tokens, hash ${workspaceExport.value.contentHash.slice(
        0,
        12,
      )}`,
    ],
  ];

  const argMaxNote = await observeArgMax(catalog, config);
  const markdown = renderMarkdown({
    source: corpusSource,
    benchRoot,
    stats,
    rows,
    measuredAt,
    machine: os.cpus()[0]?.model ?? "unknown CPU",
    runs: RUNS,
    argMaxNote,
    structureDir,
    selectedFiles,
    treeAnchorFiles,
    treeRows,
  });
  await mkdir(dirname(docsPath), { recursive: true });
  await writeFile(docsPath, markdown, "utf8");
  console.log(markdownTable(rows));
  console.log(`\nWrote ${relative(root, docsPath)}`);
}

async function assertBuilt() {
  try {
    await readFile(join(root, "packages/core/dist/index.js"), "utf8");
  } catch {
    throw new Error("Run pnpm build before node scripts/bench.mjs.");
  }
}

async function prepareCorpusCopy(source) {
  await stat(source);
  const destination = join(os.tmpdir(), `rp-mini-bench-${process.pid}-${crypto.randomUUID()}`);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const rel = relative(source, path);
      return (
        rel === "" ||
        (!rel.startsWith(".git/") &&
          rel !== ".git" &&
          !rel.startsWith(".rp-mini/") &&
          rel !== ".rp-mini")
      );
    },
  });
  return destination;
}

async function medianMeasure(fn) {
  const results = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = process.hrtime.bigint();
    const value = await fn();
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    results.push({ ms, value });
  }
  return results.sort((a, b) => a.ms - b.ms)[Math.floor(results.length / 2)];
}

function corpusStats(catalog) {
  let files = 0;
  let dirs = 0;
  let ignored = 0;
  let bytes = 0;
  for (const rootCatalog of catalog.roots) {
    files += rootCatalog.files.length;
    dirs += rootCatalog.dirs.length;
    ignored += rootCatalog.ignored;
    bytes += rootCatalog.files.reduce((total, file) => total + file.size, 0);
  }
  return { files, dirs, ignored, bytes };
}

function directoryWithCodemapFiles(catalog, count) {
  const counts = new Map();
  for (const file of catalog.roots.flatMap((entry) => entry.files)) {
    if (
      !/\.(ts|tsx|js|mjs|cjs|py|go|rs|swift|java|c|h|cpp|cc|cxx|hpp|hh|hxx|cs|rb|php|dart)$/.test(
        file.relativePath,
      )
    ) {
      continue;
    }
    const dir = file.relativePath.includes("/")
      ? file.relativePath.split("/").slice(0, -1).join("/")
      : ".";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const match = [...counts.entries()]
    .filter(([, value]) => value >= count)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return match?.[0] ?? ".";
}

function firstTextFiles(catalog, count) {
  return catalog.roots
    .flatMap((entry) => entry.files)
    .filter((file) => !file.isBinary && !file.oversized && !file.likelyGenerated)
    .slice(0, count)
    .map((file) => file.relativePath);
}

function spreadTextFiles(catalog, count) {
  const files = catalog.roots
    .flatMap((entry) => entry.files)
    .filter((file) => !file.isBinary && !file.oversized && !file.likelyGenerated)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (files.length <= count) return files.map((file) => file.relativePath);
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const file = files[Math.floor((index * (files.length - 1)) / Math.max(1, count - 1))];
    if (file && !seen.has(file.relativePath)) {
      selected.push(file.relativePath);
      seen.add(file.relativePath);
    }
  }
  for (const file of files) {
    if (selected.length >= count) break;
    if (!seen.has(file.relativePath)) selected.push(file.relativePath);
  }
  return selected;
}

function anchorRetentionStats(tree, selectedFiles) {
  const wanted = new Set();
  for (const file of selectedFiles) {
    const parts = file.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      wanted.add(parts[index]);
    }
  }
  let visible = 0;
  for (const part of wanted) {
    if (tree.includes(part)) visible += 1;
  }
  return { visible, total: wanted.size };
}

function topLevelCoverageStats(tree, catalog) {
  const topLevel = new Set();
  for (const rootCatalog of catalog.roots) {
    for (const dir of rootCatalog.dirs) {
      const [top] = dir.relativePath.split("/");
      if (top) topLevel.add(top);
    }
  }
  let visible = 0;
  for (const dir of topLevel) {
    if (
      tree.includes(`├── ${dir}`) ||
      tree.includes(`└── ${dir}`) ||
      tree.includes(`├── ${dir}/`) ||
      tree.includes(`└── ${dir}/`)
    ) {
      visible += 1;
    }
  }
  return { visible, total: topLevel.size };
}

async function observeArgMax(catalog, config) {
  const files = catalog.roots.reduce((total, rootCatalog) => total + rootCatalog.files.length, 0);
  try {
    await searchFiles(catalog, config, { pattern: "import", mode: "content", max_results: 5 });
    return `No ARG_MAX failure observed during content searches with ${files} catalog-approved files.`;
  } catch (error) {
    return `No ARG_MAX failure confirmed; broad content query hit search subprocess output buffering instead: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function renderMarkdown({
  source,
  benchRoot,
  stats,
  rows,
  measuredAt,
  machine,
  runs,
  argMaxNote,
  structureDir,
  selectedFiles,
  treeAnchorFiles,
  treeRows,
}) {
  return `# rp-mini Benchmarks

Measured on ${measuredAt}. Each metric is the median of N=${runs} runs using \`process.hrtime.bigint()\`.

## Corpus

- Source: \`${source}\`
- Measurement root: temporary copy at \`${benchRoot}\`
- Files: ${stats.files}
- Directories: ${stats.dirs}
- Ignored entries: ${stats.ignored}
- Cataloged bytes: ${stats.bytes}
- Machine: ${machine}
- Node: ${process.version}

The benchmark reads \`../repoprompt-ce\` but does not write to it. Cache and export writes happen inside the temporary measurement root.

## Results

${markdownTable(rows)}

## Tree Quality

Selected anchors for tree quality: ${treeAnchorFiles.map((file) => `\`${file}\``).join(", ")}.

${treeMarkdownTable(treeRows)}

## Notes

- ${argMaxNote}
- \`get_code_structure\` directory: \`${structureDir}\`
- Workspace export selected ${selectedFiles.length} files.
- This is not a CE-side comparative benchmark; it proves rp-mini's local behavior on the reference corpus.
`;
}

function markdownTable(rows) {
  return [
    "| Metric | Median | Detail |",
    "| --- | ---: | --- |",
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} |`),
  ].join("\n");
}

function treeMarkdownTable(rows) {
  return [
    "| Budget | Median render | Tokens used | Anchor retention | Top-level coverage |",
    "| ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} | ${row[4]} |`),
  ].join("\n");
}

function formatMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function filesPerSecond(files, ms) {
  return ms > 0 ? (files / (ms / 1000)).toFixed(1) : "inf";
}

function parseArgs(args) {
  const positionals = [];
  let date;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--date") {
      date = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--date=")) {
      date = arg.slice("--date=".length);
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    }
  }
  return { positionals, date };
}
