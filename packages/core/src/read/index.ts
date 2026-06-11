import { readFile, stat } from "node:fs/promises";
import type { CatalogFile } from "../catalog/index.js";
import { verifyFresh } from "../catalog/index.js";

export interface ReadFileOptions {
  startLine?: number;
  limit?: number;
}

export interface ReadFileSuccess {
  content: string;
  totalLines: number;
  firstLine: number;
  lastLine: number;
}

export interface ReadFileError {
  error: {
    code: "binary" | "too_large";
    message: string;
  };
}

export type ReadFileBatchEntry = { path: string; entry?: CatalogFile };

export type ReadFileBatchFile = (ReadFileSuccess | ReadFileError) & {
  path: string;
  limit_hit?: boolean;
  omitted?: number;
  suggestion?: string;
};

export interface ReadFileBatchResult {
  files: ReadFileBatchFile[];
  invalid_paths: string[];
  limit_hit: boolean;
  omitted_total: number;
  suggestion?: string;
}

export interface ReadFileBatchOptions extends ReadFileOptions {
  totalCharBudget: number;
  concurrency: number;
}

export async function readFileSlice(
  entry: CatalogFile,
  options: ReadFileOptions,
): Promise<ReadFileSuccess | ReadFileError> {
  if (entry.isBinary) {
    return { error: { code: "binary", message: `${entry.relativePath} is binary.` } };
  }
  if (entry.oversized) {
    return {
      error: { code: "too_large", message: `${entry.relativePath} exceeds file size cap.` },
    };
  }

  const fresh = await verifyFresh(entry);
  if (!fresh.fresh) await stat(entry.absolutePath);
  const content = await readFile(entry.absolutePath, "utf8");
  const lines = splitLines(content);
  const totalLines = lines.length;
  const startLine = options.startLine ?? 1;
  const firstIndex =
    startLine < 0
      ? Math.max(totalLines + startLine, 0)
      : Math.min(Math.max(startLine - 1, 0), totalLines);
  const count = startLine < 0 ? Math.abs(startLine) : (options.limit ?? totalLines - firstIndex);
  const selected = lines.slice(firstIndex, firstIndex + count);
  const firstLine = totalLines === 0 ? 0 : firstIndex + 1;
  const lastLine = selected.length === 0 ? firstLine : firstIndex + selected.length;

  return {
    content: selected.join(""),
    totalLines,
    firstLine,
    lastLine,
  };
}

export async function readFileBatch(
  requested: ReadFileBatchEntry[],
  options: ReadFileBatchOptions,
): Promise<ReadFileBatchResult> {
  const valid = requested
    .map((item, index) => ({ ...item, index }))
    .filter((item): item is ReadFileBatchEntry & { entry: CatalogFile; index: number } =>
      Boolean(item.entry),
    );
  const invalid_paths = requested.filter((item) => !item.entry).map((item) => item.path);
  const perFileCap = Math.max(
    0,
    Math.floor(options.totalCharBudget / Math.max(requested.length, 1)),
  );
  const suggestion = "Use fewer paths, narrower ranges, or raise caps.search_chars.";

  const hydrated = await mapConcurrent(valid, options.concurrency, async (item) => {
    const result = await readFileSlice(item.entry, options);
    const withPath: ReadFileBatchFile = { path: item.path, ...result };
    if ("content" in withPath && withPath.content.length > perFileCap) {
      const omitted = withPath.content.length - perFileCap;
      return {
        ...withPath,
        content: withPath.content.slice(0, perFileCap),
        limit_hit: true,
        omitted,
        suggestion,
      };
    }
    return withPath;
  });

  const files = hydrated;
  const omitted_total = files.reduce((sum, file) => sum + (file.omitted ?? 0), 0);
  return {
    files,
    invalid_paths,
    limit_hit: omitted_total > 0,
    omitted_total,
    ...(omitted_total > 0 ? { suggestion } : {}),
  };
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const matches = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return matches.filter((line) => line.length > 0);
}
