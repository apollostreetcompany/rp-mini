import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import type { CatalogFile, FileCatalog } from "../catalog/index.js";
import type { Config } from "../config/index.js";
import { lookupDefiningFiles } from "../codemaps/index.js";

const execFileAsync = promisify(execFile);

export type SearchMode = "auto" | "path" | "content" | "both";

export interface SearchFilters {
  paths?: string[];
  extensions?: string[];
  exclude?: string[];
}

export interface SearchOptions {
  pattern: string;
  mode?: SearchMode;
  regex?: boolean;
  whole_word?: boolean;
  context_lines?: number;
  max_results?: number;
  filters?: SearchFilters;
  contextPaths?: string[];
  symbolIndex?: unknown;
}

export interface SearchMatch {
  path: string;
  line?: number;
  column?: number;
  matchText?: string;
  contextBefore?: string[];
  contextAfter?: string[];
  kind?: "content" | "path";
  score?: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  file_counts: Array<{ path: string; count: number }>;
  limit_hit: boolean;
  omitted_total: number;
  suggestion?: string;
}

export type GitRecencyCache = Map<string, number>;

interface RankOptions {
  contextPaths?: string[];
  recency?: GitRecencyCache;
  symbolIndex?: unknown;
}

interface RgMatchEvent {
  type: "match";
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: Array<{ match: { text: string }; start: number }>;
  };
}

interface RgContextEvent {
  type: "context";
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
}

const require = createRequire(import.meta.url);
const gitRecencyMemo = new Map<string, Promise<GitRecencyCache>>();

export async function searchFiles(
  catalog: FileCatalog,
  config: Config,
  options: SearchOptions,
): Promise<SearchResult> {
  const maxResults = options.max_results ?? 50;
  const collectLimit = maxResults + 1;
  const mode = resolveMode(options.pattern, options.mode ?? "auto");
  const pathMatches =
    mode === "path" || mode === "both"
      ? pathSearch(catalog, options, mode === "path" ? 0.15 : 0.35).slice(0, collectLimit)
      : [];
  const remaining = Math.max(collectLimit - pathMatches.length, 0);
  const contentMatches =
    (mode === "content" || mode === "both") && remaining > 0
      ? await contentSearch(catalog, config, options, remaining)
      : [];
  const recency = await getGitRecencyCache(catalog.roots[0]?.root ?? process.cwd());
  const ranked = rankSearchResults([...pathMatches, ...contentMatches], {
    contextPaths: options.contextPaths,
    recency,
    symbolIndex: options.symbolIndex,
  });
  return shapeSearchResult(ranked, maxResults, config.caps.search_chars);
}

export function rankSearchResults(
  matches: SearchMatch[],
  options: RankOptions = {},
): SearchMatch[] {
  return matches
    .map((match, index) => {
      const baseline = Math.max(0, 1000 - index);
      const proximity = Math.max(
        0,
        ...(options.contextPaths ?? []).map((contextPath) =>
          commonPrefixDepth(match.path, contextPath),
        ),
      );
      const recencyRank = options.recency?.get(match.path);
      const recencyBoost = recencyRank === undefined ? 0 : Math.max(0, 200 - recencyRank);
      const symbolBoost = symbolDefinitionBoost(match, options.symbolIndex);
      return {
        ...match,
        score: (match.score ?? 0) + baseline + proximity * 40 + recencyBoost + symbolBoost,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
}

function symbolDefinitionBoost(match: SearchMatch, symbolIndex: unknown): number {
  const symbol = match.matchText?.match(/\b[A-Z][A-Za-z0-9_]*\b/)?.[0];
  if (!symbol) return 0;
  return lookupDefiningFiles(symbolIndex, symbol).includes(match.path) ? 2000 : 0;
}

export async function buildGitRecencyCache(root: string): Promise<GitRecencyCache> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-200", "--name-only", "--pretty=format:"],
      { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    const cache: GitRecencyCache = new Map();
    let rank = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const path = line.trim();
      if (!path || cache.has(path)) continue;
      cache.set(toPosix(path), rank);
      rank += 1;
    }
    return cache;
  } catch {
    return new Map();
  }
}

async function getGitRecencyCache(root: string): Promise<GitRecencyCache> {
  let existing = gitRecencyMemo.get(root);
  if (!existing) {
    existing = buildGitRecencyCache(root);
    gitRecencyMemo.set(root, existing);
  }
  return existing;
}

export function resolveRipgrepBinary(config: Config): string {
  const configured = config.search?.ripgrep_path;
  if (configured) return configured;
  try {
    return require("@vscode/ripgrep").rgPath as string;
  } catch {
    return "rg";
  }
}

function pathSearch(
  catalog: FileCatalog,
  options: SearchOptions,
  fuzzyThreshold: number,
): SearchMatch[] {
  const query = options.pattern.toLowerCase();
  return catalogFiles(catalog, options.filters)
    .map((file) => {
      const path = file.relativePath;
      const lowerPath = path.toLowerCase();
      const substringScore = lowerPath.includes(query) ? 500 : 0;
      const fuzzy = bigramDice(query, lowerPath);
      const fuzzyScore = fuzzy >= fuzzyThreshold ? fuzzy * 400 : 0;
      return { path, kind: "path" as const, matchText: path, score: substringScore + fuzzyScore };
    })
    .filter((match) => (match.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
}

async function contentSearch(
  catalog: FileCatalog,
  config: Config,
  options: SearchOptions,
  maxResults: number,
): Promise<SearchMatch[]> {
  const rg = resolveRipgrepBinary(config);
  const matches: SearchMatch[] = [];
  for (const root of catalog.roots) {
    const files = root.files
      .filter((file) => !file.isBinary && !file.oversized && !file.likelyGenerated)
      .filter((file) => matchesFilters(file.relativePath, options.filters));
    if (files.length === 0) continue;
    const args = [
      "--json",
      "--color=never",
      "--no-heading",
      ...(options.regex ? [] : ["-F"]),
      ...(options.whole_word ? ["-w"] : []),
      ...(options.context_lines ? ["-C", String(options.context_lines)] : []),
      options.pattern,
      ...files.map((file) => file.relativePath),
    ];
    try {
      const { stdout } = await execFileAsync(rg, args, {
        cwd: root.root,
        maxBuffer: Math.max(config.caps.search_chars * 4, 1024 * 1024),
      });
      const pendingBefore = new Map<string, string[]>();
      const lastMatchByPath = new Map<string, SearchMatch>();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue;
        const event = JSON.parse(line) as RgMatchEvent | RgContextEvent | { type: string };
        if (event.type === "context") {
          const context = event as RgContextEvent;
          const path = toPosix(context.data.path.text);
          const lastMatch = lastMatchByPath.get(path);
          if (lastMatch?.line !== undefined && context.data.line_number > lastMatch.line) {
            lastMatch.contextAfter ??= [];
            lastMatch.contextAfter.push(context.data.lines.text);
          } else {
            const before = pendingBefore.get(path) ?? [];
            before.push(context.data.lines.text);
            pendingBefore.set(path, before);
          }
          continue;
        }
        if (event.type !== "match") continue;
        const match = event as RgMatchEvent;
        const path = toPosix(match.data.path.text);
        const submatch = match.data.submatches[0];
        const searchMatch: SearchMatch = {
          path,
          line: match.data.line_number,
          column: submatch ? submatch.start + 1 : 1,
          matchText: submatch?.match.text ?? match.data.lines.text.trimEnd(),
          contextBefore: pendingBefore.get(path),
          kind: "content",
        };
        pendingBefore.delete(path);
        lastMatchByPath.set(path, searchMatch);
        matches.push(searchMatch);
        if (matches.length >= maxResults) return matches;
      }
    } catch (error) {
      if (isNoMatches(error)) continue;
      throw error;
    }
  }
  return matches;
}

function shapeSearchResult(
  matches: SearchMatch[],
  maxResults: number,
  charCap: number,
): SearchResult {
  const fileCounts = new Map<string, number>();
  for (const match of matches) fileCounts.set(match.path, (fileCounts.get(match.path) ?? 0) + 1);

  const kept: SearchMatch[] = [];
  let omitted = 0;
  for (const match of matches.slice(0, maxResults)) {
    const next = [...kept, match];
    if (JSON.stringify(next).length > charCap) {
      omitted += 1;
      continue;
    }
    kept.push(match);
  }
  omitted += Math.max(0, matches.length - maxResults);
  return {
    matches: kept,
    file_counts: [...fileCounts.entries()].map(([path, count]) => ({ path, count })),
    limit_hit: omitted > 0,
    omitted_total: omitted,
    ...(omitted > 0
      ? {
          suggestion:
            "Refine or narrow the pattern, add path/extension filters, or lower context_lines.",
        }
      : {}),
  };
}

function resolveMode(pattern: string, mode: SearchMode): Exclude<SearchMode, "auto"> {
  if (mode !== "auto") return mode;
  return /[/*?[\]{}]/.test(pattern) ? "path" : "both";
}

function catalogFiles(catalog: FileCatalog, filters?: SearchFilters): CatalogFile[] {
  return catalog.roots
    .flatMap((root) =>
      root.files.map((file) => ({
        ...file,
        relativePath: toPosix(file.relativePath),
      })),
    )
    .filter((file) => matchesFilters(file.relativePath, filters));
}

function matchesFilters(path: string, filters?: SearchFilters): boolean {
  if (!filters) return true;
  const normalized = toPosix(path);
  if (filters.paths?.length) {
    const paths = filters.paths.map((entry) => toPosix(entry).replace(/\/+$/, ""));
    if (!paths.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))) {
      return false;
    }
  }
  if (filters.extensions?.length && !filters.extensions.some((ext) => normalized.endsWith(ext))) {
    return false;
  }
  if (filters.exclude?.some((entry) => normalized.includes(toPosix(entry).replace(/\*/g, "")))) {
    return false;
  }
  return true;
}

function bigramDice(query: string, candidate: string): number {
  const a = bigrams(query.replace(/\s+/g, ""));
  const b = bigrams(candidate.replace(/[^\p{L}\p{N}]+/gu, ""));
  if (a.size === 0 || b.size === 0) return candidate.includes(query) ? 1 : 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function bigrams(value: string): Set<string> {
  const lower = value.toLowerCase();
  if (lower.length <= 1) return new Set(lower ? [lower] : []);
  return new Set(
    Array.from({ length: lower.length - 1 }, (_, index) => lower.slice(index, index + 2)),
  );
}

function commonPrefixDepth(a: string, b: string): number {
  const aParts = toPosix(a).split("/");
  const bParts = toPosix(b).split("/");
  let depth = 0;
  while (aParts[depth] && aParts[depth] === bParts[depth]) depth += 1;
  return depth;
}

function isNoMatches(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 1;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
