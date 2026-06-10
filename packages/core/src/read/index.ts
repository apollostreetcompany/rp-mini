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

function splitLines(content: string): string[] {
  if (!content) return [];
  const matches = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return matches.filter((line) => line.length > 0);
}
