import { open, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import type { Config } from "../config/index.js";

const IGNORE_FILES = [".gitignore", ".repo_ignore", ".cursorignore"];
const BINARY_SNIFF_BYTES = 8192;
const HARD_IGNORES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".rp-mini",
  "node_modules",
  "__pycache__",
  ".gradle",
  ".idea",
  ".cargo",
  "dist",
  "build",
  ".DS_Store",
]);
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "composer.lock",
]);

export interface CatalogEntry {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export interface CatalogFile extends CatalogEntry {
  kind: "file";
  isBinary: boolean;
  oversized: boolean;
  likelyGenerated: boolean;
}

export interface CatalogDir extends CatalogEntry {
  kind: "dir";
}

export interface CatalogRoot {
  root: string;
  files: CatalogFile[];
  dirs: CatalogDir[];
  ignored: number;
  tookMs: number;
  iosPresetApplied: boolean;
}

export interface FileCatalog {
  roots: CatalogRoot[];
  generatedAt: string;
}

export interface FreshnessResult {
  fresh: boolean;
  currentMtimeMs: number | null;
}

interface IgnoreRuleSet {
  matcher: ReturnType<typeof ignore>;
}

const catalogMemo = new Map<string, Promise<FileCatalog>>();

export async function getCatalog(roots: string[], config: Config): Promise<FileCatalog> {
  const resolvedRoots = roots.map((root) => resolve(root));
  const key = JSON.stringify({
    roots: resolvedRoots,
    fileSizeBytes: config.caps.file_size_bytes,
    ignore: config.ignore,
  });
  let existing = catalogMemo.get(key);
  if (!existing) {
    existing = buildCatalog(resolvedRoots, config);
    catalogMemo.set(key, existing);
  }
  return existing;
}

export function invalidateCatalog(): void {
  catalogMemo.clear();
}

export async function buildCatalog(roots: string[], config: Config): Promise<FileCatalog> {
  const catalogRoots = await Promise.all(
    roots.map(async (root) => {
      const start = performance.now();
      const absoluteRoot = resolve(root);
      const ruleSet = createIgnoreRuleSet(config.ignore.extra);
      const iosPresetApplied = await shouldApplyIosPreset(absoluteRoot, config);
      if (iosPresetApplied) addIosPreset(ruleSet);
      const result: CatalogRoot = {
        root: absoluteRoot,
        files: [],
        dirs: [],
        ignored: 0,
        tookMs: 0,
        iosPresetApplied,
      };
      await walkDirectory(absoluteRoot, "", ruleSet, config, result);
      result.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      result.dirs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      result.tookMs = performance.now() - start;
      return result;
    }),
  );
  return { roots: catalogRoots, generatedAt: new Date().toISOString() };
}

export async function verifyFresh(entry: CatalogEntry): Promise<FreshnessResult> {
  try {
    const current = await stat(entry.absolutePath);
    return { fresh: current.mtimeMs === entry.mtimeMs, currentMtimeMs: current.mtimeMs };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { fresh: false, currentMtimeMs: null };
    }
    throw error;
  }
}

export function isLikelyGenerated(path: string, sampleText: string): boolean {
  const normalized = toPosix(path);
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/\.(?:min|bundle)\.[^.]+$/i.test(basename)) return true;
  if (LOCKFILES.has(basename)) return true;

  const lines = sampleText.split(/\r?\n/).slice(0, 50).filter(Boolean);
  if (lines.length === 0) return false;
  const averageLineLength =
    lines.reduce((total, line) => total + line.length, 0) / Math.max(lines.length, 1);
  return averageLineLength > 300;
}

async function walkDirectory(
  root: string,
  relativeDir: string,
  ruleSet: IgnoreRuleSet,
  config: Config,
  catalogRoot: CatalogRoot,
): Promise<void> {
  await loadLocalIgnoreFiles(root, relativeDir, ruleSet);
  const absoluteDir = relativeDir ? join(root, relativeDir) : root;
  const entries = await readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = toPosix(relativeDir ? join(relativeDir, entry.name) : entry.name);
    if (shouldHardIgnore(relativePath) || ruleSet.matcher.ignores(relativePath)) {
      catalogRoot.ignored += 1;
      continue;
    }

    const absolutePath = join(root, relativePath);
    const stats = await stat(absolutePath);
    if (entry.isDirectory()) {
      catalogRoot.dirs.push({
        kind: "dir",
        relativePath,
        absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      if (relativePath.endsWith(".xcassets")) continue;
      await walkDirectory(root, relativePath, ruleSet, config, catalogRoot);
    } else if (entry.isFile()) {
      catalogRoot.files.push(await fileEntry(relativePath, absolutePath, stats, config));
    }
  }
}

async function fileEntry(
  relativePath: string,
  absolutePath: string,
  stats: { size: number; mtimeMs: number },
  config: Config,
): Promise<CatalogFile> {
  const sample = await readFileSample(absolutePath);
  const isBinary = sample.includes(0);
  const sampleText = isBinary ? "" : sample.toString("utf8");
  return {
    kind: "file",
    relativePath,
    absolutePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isBinary,
    oversized: stats.size > config.caps.file_size_bytes,
    likelyGenerated: isLikelyGenerated(relativePath, sampleText),
  };
}

async function readFileSample(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function loadLocalIgnoreFiles(
  root: string,
  relativeDir: string,
  ruleSet: IgnoreRuleSet,
): Promise<void> {
  for (const filename of IGNORE_FILES) {
    const relativePath = toPosix(relativeDir ? join(relativeDir, filename) : filename);
    try {
      const raw = await readFile(join(root, relativePath), "utf8");
      addRules(ruleSet, relativeDir, raw.split(/\r?\n/));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

function createIgnoreRuleSet(extra: string[]): IgnoreRuleSet {
  const ruleSet = { matcher: ignore() };
  addRules(ruleSet, "", extra);
  return ruleSet;
}

function addIosPreset(ruleSet: IgnoreRuleSet): void {
  addRules(ruleSet, "", [
    "**/*.xcodeproj",
    "**/*.xcodeproj/**",
    "**/Info.plist",
    "**/*.storyboard",
    "**/*.xib",
    "**/*.xcassets/**",
  ]);
}

function addRules(ruleSet: IgnoreRuleSet, baseDir: string, patterns: string[]): void {
  const transformed = patterns.flatMap((pattern) => transformPattern(baseDir, pattern));
  if (transformed.length > 0) ruleSet.matcher.add(transformed);
}

function transformPattern(baseDir: string, rawPattern: string): string[] {
  const trimmed = rawPattern.trim();
  if (!trimmed || trimmed.startsWith("#")) return [];

  const negated = trimmed.startsWith("!");
  const pattern = negated ? trimmed.slice(1) : trimmed;
  const prefix = negated ? "!" : "";
  const normalizedBase = toPosix(baseDir);
  const normalizedPattern = toPosix(pattern).replace(/^\/+/, "");
  if (!normalizedBase) return [`${prefix}${normalizedPattern}`];
  if (!normalizedPattern.includes("/")) {
    return [
      `${prefix}${normalizedBase}/${normalizedPattern}`,
      `${prefix}${normalizedBase}/**/${normalizedPattern}`,
    ];
  }
  return [`${prefix}${normalizedBase}/${normalizedPattern}`];
}

async function shouldApplyIosPreset(root: string, config: Config): Promise<boolean> {
  if (config.ignore.ios_preset === true) return true;
  if (config.ignore.ios_preset === false) return false;
  const entries = await readdir(root, { withFileTypes: true });
  return entries.some(
    (entry) =>
      (entry.isDirectory() && entry.name.endsWith(".xcodeproj")) || entry.name === "Package.swift",
  );
}

function shouldHardIgnore(relativePath: string): boolean {
  return toPosix(relativePath)
    .split("/")
    .some((segment) => HARD_IGNORES.has(segment));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function resolveRootPath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

export function relativeToRoot(root: string, path: string): string {
  return toPosix(relative(resolve(root), resolveRootPath(root, path)));
}
