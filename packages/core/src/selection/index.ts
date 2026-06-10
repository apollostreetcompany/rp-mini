import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { CatalogFile, FileCatalog } from "../catalog/index.js";
import { atomicWriteJson, cacheDir, readJsonIfValid } from "../cache/index.js";
import {
  buildTypeIndex,
  canCodemapFile,
  getCodeStructures,
  lookupDefiningFiles,
  serializeFileApi,
  type FileApi,
} from "../codemaps/index.js";
import type { Config } from "../config/index.js";
import { estimateTokens as defaultEstimateTokens } from "../tokens/index.js";

export type SelectionMode = "full" | "slices" | "codemap";

export interface SelectionSlice {
  start: number;
  end: number;
  description?: string;
}

export interface SelectionEntry {
  path: string;
  mode: SelectionMode;
  slices: SelectionSlice[];
  contentSha256: string;
  tokens: EntryTokenCounts;
  slices_invalidated?: boolean;
}

export interface EntryTokenCounts {
  full: number;
  codemap: number;
  slicesTotal: number;
}

export interface SelectionTotals {
  files: number;
  full: number;
  slices: number;
  codemaps: number;
  prompt: number;
  total: number;
}

export interface SelectionSnapshot {
  entries: SelectionEntry[];
  autoCodemapPaths: string[];
  prompt: string;
  totals: SelectionTotals;
}

export interface SelectionMutation {
  path: string;
  mode?: SelectionMode;
  slices?: SelectionSlice[];
}

export interface SelectionStateOptions {
  root: string;
  config: Config;
  catalog: FileCatalog;
  sessionId?: string;
  estimateTokens?: (text: string) => number;
}

interface StoredSelection {
  version: 1;
  prompt: string;
  entries: StoredEntry[];
}

interface StoredEntry {
  path: string;
  mode: SelectionMode;
  slices: SelectionSlice[];
  contentSha256: string;
  slices_invalidated?: boolean;
}

interface TokenCacheEntry {
  full: number;
  codemap: number;
  sliceTokens: Record<string, number>;
  slicesTotal: number;
}

const STORAGE_VERSION = 1;

export class SelectionState {
  private readonly root: string;
  private readonly config: Config;
  private catalog: FileCatalog;
  private readonly sessionId: string;
  private readonly estimateTokens: (text: string) => number;
  private readonly explicitEntries = new Map<string, SelectionEntry>();
  private readonly autoCodemapPaths = new Set<string>();
  private readonly tokenCache = new Map<string, TokenCacheEntry>();
  private promptText = "";
  private promptTokens = 0;
  private aggregate = { full: 0, slices: 0, codemaps: 0 };

  constructor(options: SelectionStateOptions) {
    this.root = options.root;
    this.config = options.config;
    this.catalog = options.catalog;
    this.sessionId =
      this.config.selection.scope === "workspace"
        ? "shared"
        : (options.sessionId ?? crypto.randomUUID());
    this.estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  }

  updateCatalog(catalog: FileCatalog): void {
    this.catalog = catalog;
  }

  async load(): Promise<void> {
    if (!this.config.selection.persist) return;
    const stored = await readJsonIfValid<StoredSelection>(this.storagePath());
    if (stored?.version !== STORAGE_VERSION) return;
    this.promptText = stored.prompt ?? "";
    this.promptTokens = this.estimateTokens(this.promptText);
    this.explicitEntries.clear();
    for (const entry of stored.entries ?? []) {
      const file = this.findFile(entry.path);
      if (!file) continue;
      const loaded = await this.createEntry(file, entry.mode, entry.slices ?? [], {
        storedSha: entry.contentSha256,
        slicesInvalidated: entry.slices_invalidated,
      });
      this.explicitEntries.set(loaded.path, loaded);
    }
    await this.recomputeAutoCodemaps();
    this.recomputeAggregate();
  }

  async save(): Promise<void> {
    if (!this.config.selection.persist) return;
    await atomicWriteJson(this.storagePath(), this.toStored());
  }

  async saveProfile(name: string): Promise<void> {
    await atomicWriteJson(this.profilePath(name), this.toStored());
  }

  async loadProfile(name: string): Promise<void> {
    const stored = await readJsonIfValid<StoredSelection>(this.profilePath(name));
    if (stored?.version !== STORAGE_VERSION) {
      throw new Error(`Profile not found: ${name}`);
    }
    this.clearInMemory();
    this.promptText = stored.prompt ?? "";
    this.promptTokens = this.estimateTokens(this.promptText);
    for (const entry of stored.entries ?? []) {
      const file = this.findFile(entry.path);
      if (!file) continue;
      const loaded = await this.createEntry(file, entry.mode, entry.slices ?? [], {
        storedSha: entry.contentSha256,
        slicesInvalidated: entry.slices_invalidated,
      });
      this.explicitEntries.set(loaded.path, loaded);
    }
    await this.recomputeAutoCodemaps();
    this.recomputeAggregate();
    await this.save();
  }

  async listProfiles(): Promise<string[]> {
    const dir = join(cacheDir(this.root), "profiles");
    try {
      const { readdir } = await import("node:fs/promises");
      return (await readdir(dir))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.replace(/\.json$/, ""))
        .sort();
    } catch {
      return [];
    }
  }

  async set(mutations: SelectionMutation[]): Promise<void> {
    this.explicitEntries.clear();
    await this.add(mutations, { skipSave: true });
    await this.save();
  }

  async add(mutations: SelectionMutation[], options: { skipSave?: boolean } = {}): Promise<void> {
    for (const mutation of mutations) {
      const file = this.findFile(mutation.path);
      if (!file) continue;
      const mode = mutation.mode ?? "full";
      const lineCount = mode === "slices" ? await countLines(file.absolutePath) : 0;
      const slices = mode === "slices" ? normalizeSlices(mutation.slices ?? [], lineCount) : [];
      const existing = this.explicitEntries.get(file.relativePath);
      const nextSlices =
        mode === "slices" && existing?.mode === "slices"
          ? normalizeSlices([...existing.slices, ...slices], lineCount)
          : slices;
      const entry = await this.createEntry(file, mode, nextSlices);
      this.explicitEntries.set(entry.path, entry);
      this.autoCodemapPaths.delete(entry.path);
    }
    await this.recomputeAutoCodemaps();
    this.recomputeAggregate();
    if (!options.skipSave) await this.save();
  }

  async remove(mutations: SelectionMutation[]): Promise<void> {
    for (const mutation of mutations) {
      const file = this.findFile(mutation.path);
      if (!file) continue;
      const existing = this.explicitEntries.get(file.relativePath);
      if (!existing) continue;
      if (mutation.slices?.length && existing.mode === "slices") {
        const remaining = subtractSlices(existing.slices, mutation.slices);
        if (remaining.length === 0) this.explicitEntries.delete(file.relativePath);
        else
          this.explicitEntries.set(
            file.relativePath,
            await this.createEntry(file, "slices", remaining),
          );
      } else {
        this.explicitEntries.delete(file.relativePath);
      }
    }
    await this.recomputeAutoCodemaps();
    this.recomputeAggregate();
    await this.save();
  }

  async clear(): Promise<void> {
    this.clearInMemory();
    await this.save();
  }

  async promote(paths: string[]): Promise<void> {
    await this.changeModes(paths, "full");
  }

  async demote(paths: string[]): Promise<void> {
    await this.changeModes(paths, "codemap");
  }

  async setPrompt(text: string): Promise<void> {
    this.promptText = text;
    this.promptTokens = this.estimateTokens(text);
    await this.save();
  }

  async appendPrompt(text: string): Promise<void> {
    await this.setPrompt(`${this.promptText}${text}`);
  }

  async clearPrompt(): Promise<void> {
    await this.setPrompt("");
  }

  getPrompt(): { text: string; tokens: number } {
    return { text: this.promptText, tokens: this.promptTokens };
  }

  async validateFresh(): Promise<void> {
    let changed = false;
    for (const [path, entry] of this.explicitEntries) {
      const file = this.findFile(path);
      if (!file) continue;
      const content = await readFile(file.absolutePath, "utf8");
      const contentSha256 = sha256(content);
      if (entry.mode === "slices" && entry.contentSha256 !== contentSha256) {
        this.explicitEntries.set(
          path,
          await this.createEntry(file, "full", [], {
            slicesInvalidated: true,
          }),
        );
        changed = true;
      }
    }
    if (changed) {
      await this.recomputeAutoCodemaps();
      this.recomputeAggregate();
      await this.save();
    }
  }

  snapshot(): SelectionSnapshot {
    const explicit = [...this.explicitEntries.values()];
    const auto = [...this.autoCodemapPaths]
      .sort()
      .map((path) => this.createAutoEntrySnapshot(path))
      .filter((entry): entry is SelectionEntry => entry !== null);
    return {
      entries: [...explicit, ...auto].sort((a, b) => a.path.localeCompare(b.path)),
      autoCodemapPaths: [...this.autoCodemapPaths].sort(),
      prompt: this.promptText,
      totals: {
        files: this.explicitEntries.size + this.autoCodemapPaths.size,
        full: [...this.explicitEntries.values()].filter((entry) => entry.mode === "full").length,
        slices: [...this.explicitEntries.values()].filter((entry) => entry.mode === "slices")
          .length,
        codemaps:
          [...this.explicitEntries.values()].filter((entry) => entry.mode === "codemap").length +
          this.autoCodemapPaths.size,
        prompt: this.promptTokens,
        total:
          this.promptTokens + this.aggregate.full + this.aggregate.slices + this.aggregate.codemaps,
      },
    };
  }

  async recomputeTokenTotalForTest(): Promise<number> {
    let total = this.promptTokens;
    for (const entry of this.snapshot().entries) {
      if (entry.mode === "full") total += entry.tokens.full;
      else if (entry.mode === "slices") total += entry.tokens.slicesTotal;
      else total += entry.tokens.codemap;
    }
    return total;
  }

  getFile(path: string): CatalogFile | undefined {
    return this.findFile(path);
  }

  async codemapTextFor(path: string): Promise<string> {
    const result = await getCodeStructures(this.catalog, this.config, {
      paths: [path],
      maxResults: 1,
    });
    return result.files[0]?.text ?? "";
  }

  private async changeModes(paths: string[], mode: SelectionMode): Promise<void> {
    for (const path of paths) {
      const file = this.findFile(path);
      if (!file) continue;
      const existing = this.explicitEntries.get(file.relativePath);
      if (!existing && !this.autoCodemapPaths.has(file.relativePath)) continue;
      this.explicitEntries.set(file.relativePath, await this.createEntry(file, mode, []));
      this.autoCodemapPaths.delete(file.relativePath);
    }
    await this.recomputeAutoCodemaps();
    this.recomputeAggregate();
    await this.save();
  }

  private async createEntry(
    file: CatalogFile,
    mode: SelectionMode,
    slices: SelectionSlice[],
    options: { storedSha?: string; slicesInvalidated?: boolean } = {},
  ): Promise<SelectionEntry> {
    const content = await readFile(file.absolutePath, "utf8");
    const contentSha256 = sha256(content);
    let nextMode = mode;
    let nextSlices = slices;
    let slicesInvalidated = options.slicesInvalidated;
    if (mode === "slices" && options.storedSha && options.storedSha !== contentSha256) {
      nextMode = "full";
      nextSlices = [];
      slicesInvalidated = true;
    }
    const tokens = await this.entryTokens(file, content, contentSha256, nextSlices);
    return {
      path: file.relativePath,
      mode: nextMode,
      slices: nextSlices,
      contentSha256,
      tokens,
      ...(slicesInvalidated ? { slices_invalidated: true } : {}),
    };
  }

  private createAutoEntrySnapshot(path: string): SelectionEntry | null {
    const file = this.findFile(path);
    if (!file) return null;
    const cached = [...this.tokenCache.entries()].find(([key]) => key.endsWith(`:${path}`))?.[1];
    return {
      path,
      mode: "codemap",
      slices: [],
      contentSha256: cached ? "" : "",
      tokens: cached
        ? { full: cached.full, codemap: cached.codemap, slicesTotal: cached.slicesTotal }
        : { full: 0, codemap: 0, slicesTotal: 0 },
    };
  }

  private async entryTokens(
    file: CatalogFile,
    content: string,
    contentSha256: string,
    slices: SelectionSlice[],
  ): Promise<EntryTokenCounts> {
    const cacheKey = `${contentSha256}:${file.relativePath}`;
    const existing = this.tokenCache.get(cacheKey);
    const sliceTokens: Record<string, number> = { ...(existing?.sliceTokens ?? {}) };
    let full = existing?.full;
    if (full === undefined) full = this.estimateTokens(content);
    let codemap = existing?.codemap;
    if (codemap === undefined) codemap = this.estimateTokens(await this.codemapText(file));
    for (const slice of slices) {
      const key = sliceKey(slice);
      if (sliceTokens[key] === undefined)
        sliceTokens[key] = this.estimateTokens(sliceContent(content, slice));
    }
    const slicesTotal = slices.reduce((sum, slice) => sum + (sliceTokens[sliceKey(slice)] ?? 0), 0);
    this.tokenCache.set(cacheKey, { full, codemap, sliceTokens, slicesTotal });
    return { full, codemap, slicesTotal };
  }

  private async recomputeAutoCodemaps(): Promise<void> {
    this.autoCodemapPaths.clear();
    if (!this.config.selection.auto_codemaps) return;
    const typeIndex = await buildTypeIndex(this.catalog, this.config);
    const explicitPaths = new Set(this.explicitEntries.keys());
    for (const entry of this.explicitEntries.values()) {
      if (entry.mode === "codemap") continue;
      const file = this.findFile(entry.path);
      if (!file || !canCodemapFile(file, this.config)) continue;
      const api = await this.fileApiFor(entry.path);
      for (const typeName of api?.referencedTypes ?? []) {
        for (const definingPath of lookupDefiningFiles(typeIndex, typeName)) {
          if (explicitPaths.has(definingPath)) continue;
          const definingFile = this.findFile(definingPath);
          if (!definingFile || !canCodemapFile(definingFile, this.config)) continue;
          this.autoCodemapPaths.add(definingPath);
          const content = await readFile(definingFile.absolutePath, "utf8");
          await this.entryTokens(definingFile, content, sha256(content), []);
        }
      }
    }
  }

  private recomputeAggregate(): void {
    const next = { full: 0, slices: 0, codemaps: 0 };
    for (const entry of this.explicitEntries.values()) {
      if (entry.mode === "full") next.full += entry.tokens.full;
      else if (entry.mode === "slices") next.slices += entry.tokens.slicesTotal;
      else next.codemaps += entry.tokens.codemap;
    }
    for (const path of this.autoCodemapPaths) {
      const cached = [...this.tokenCache.entries()].find(([key]) => key.endsWith(`:${path}`))?.[1];
      next.codemaps += cached?.codemap ?? 0;
    }
    this.aggregate = next;
  }

  private async fileApiFor(path: string): Promise<FileApi | null> {
    const result = await getCodeStructures(this.catalog, this.config, {
      paths: [path],
      maxResults: 1,
    });
    return result.files[0]?.fileApi ?? null;
  }

  private async codemapText(file: CatalogFile): Promise<string> {
    if (!canCodemapFile(file, this.config)) return "";
    const api = await this.fileApiFor(file.relativePath);
    return api ? serializeFileApi(api) : "";
  }

  private findFile(path: string): CatalogFile | undefined {
    const normalized = normalizePath(path);
    for (const root of this.catalog.roots) {
      const match = root.files.find(
        (file) => file.relativePath === normalized || file.absolutePath === path,
      );
      if (match) return match;
    }
    return undefined;
  }

  private storagePath(): string {
    return join(cacheDir(this.root), "sessions", `${this.sessionId}.json`);
  }

  private profilePath(name: string): string {
    return join(cacheDir(this.root), "profiles", `${safeProfileName(name)}.json`);
  }

  private toStored(): StoredSelection {
    return {
      version: STORAGE_VERSION,
      prompt: this.promptText,
      entries: [...this.explicitEntries.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          slices: entry.slices,
          contentSha256: entry.contentSha256,
          ...(entry.slices_invalidated ? { slices_invalidated: true } : {}),
        })),
    };
  }

  private clearInMemory(): void {
    this.explicitEntries.clear();
    this.autoCodemapPaths.clear();
    this.promptText = "";
    this.promptTokens = 0;
    this.aggregate = { full: 0, slices: 0, codemaps: 0 };
  }
}

export function normalizeSlices(slices: SelectionSlice[], maxLine: number): SelectionSlice[] {
  if (maxLine <= 0) return [];
  const sorted = slices
    .map((slice) => ({
      start: clamp(Math.min(slice.start, slice.end), 1, maxLine),
      end: clamp(Math.max(slice.start, slice.end), 1, maxLine),
      description: slice.description,
    }))
    .filter((slice) => slice.start <= slice.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SelectionSlice[] = [];
  for (const slice of sorted) {
    const previous = merged.at(-1);
    if (!previous || slice.start > previous.end + 1) {
      merged.push({ ...slice });
      continue;
    }
    previous.end = Math.max(previous.end, slice.end);
    previous.description ??= slice.description;
  }
  return merged;
}

export function subtractSlices(
  existing: SelectionSlice[],
  removal: SelectionSlice[],
): SelectionSlice[] {
  let remaining = existing.map((slice) => ({ ...slice }));
  for (const remove of removal) {
    const start = Math.min(remove.start, remove.end);
    const end = Math.max(remove.start, remove.end);
    remaining = remaining.flatMap((slice) => {
      if (end < slice.start || start > slice.end) return [slice];
      const pieces: SelectionSlice[] = [];
      if (start > slice.start) {
        pieces.push({ start: slice.start, end: start - 1, description: slice.description });
      }
      if (end < slice.end) {
        pieces.push({ start: end + 1, end: slice.end, description: slice.description });
      }
      return pieces;
    });
  }
  return remaining;
}

export async function selectedPaths(snapshot: SelectionSnapshot): Promise<string[]> {
  return snapshot.entries.map((entry) => entry.path).sort();
}

async function countLines(path: string): Promise<number> {
  const content = await readFile(path, "utf8");
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function sliceContent(content: string, slice: SelectionSlice): string {
  const lines = content.split(/(?<=\n)/);
  return lines.slice(slice.start - 1, slice.end).join("");
}

function sliceKey(slice: SelectionSlice): string {
  return `${slice.start}-${slice.end}:${slice.description ?? ""}`;
}

function normalizePath(path: string): string {
  return path
    .split(sep)
    .join("/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function safeProfileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
