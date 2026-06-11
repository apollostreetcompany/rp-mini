import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Config } from "../config/index.js";
import { defaultConfig } from "../config/index.js";
import { invalidateCatalog } from "../catalog/index.js";
import { invalidateCodemapCacheEntry } from "../codemaps/index.js";

export type MatchedBy = "literal" | "escape" | "fuzzy" | "rewrite";

export interface EditOperation {
  search: string;
  replace: string;
  all?: boolean;
}

export interface ApplyFileEditsOptions {
  roots: string[];
  path: string;
  search?: string;
  replace?: string;
  all?: boolean;
  edits?: EditOperation[];
  rewrite?: string;
  on_missing?: "error" | "create";
  verbose?: boolean;
  dry_run?: boolean;
  expected_sha256?: string;
  config?: Config;
}

export interface FileActionOptions {
  roots: string[];
  action: "create" | "delete" | "move";
  path: string;
  content?: string;
  new_path?: string;
  if_exists?: "error" | "overwrite";
  expected_sha256?: string;
  config?: Config;
}

export interface EditPostContext {
  edit_index: number;
  start_line: number;
  end_line: number;
  text: string;
}

export interface EditSummary {
  status: "previewed" | "applied" | "error";
  path: string;
  edits_applied: number;
  matched_by: MatchedBy[];
  file_created: boolean;
  error?: EditError;
  note?: string;
  unified_diff?: string;
  dice_scores: number[];
  pre_sha256?: string;
  post_sha256?: string;
  verified?: boolean;
  post_context?: EditPostContext[];
}

export type EditError =
  | { code: "invalid_request"; message: string; edit_index?: number }
  | { code: "not_found"; path: string; edit_index?: number }
  | { code: "outside_workspace"; path: string; edit_index?: number }
  | { code: "multiple_matches"; lines: number[]; edit_index?: number }
  | { code: "no_match"; closest: { line: number; score: number } | null; edit_index?: number }
  | { code: "ambiguous_match"; candidates: number[]; edit_index?: number }
  | { code: "overlapping_edits"; edit_indices: number[] }
  | { code: "already_exists"; path: string }
  | { code: "destination_exists"; path: string }
  | { code: "stale_file"; expected_sha256: string; actual_sha256: string }
  | { code: "post_write_mismatch"; expected_sha256: string; actual_sha256: string };

interface ResolvedPath {
  root: string;
  relativePath: string;
  absolutePath: string;
}

interface WorkspacePathError {
  error: { code: "outside_workspace"; path: string };
}

interface TextShape {
  normalized: string;
  lineEnding: "\n" | "\r\n";
  hadTrailingNewline: boolean;
}

interface ResolvedEdit {
  editIndex: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  replacement: string;
  matchedBy: MatchedBy;
  diceScore?: number;
  wholeLine: boolean;
}

interface LineRecord {
  text: string;
  start: number;
  end: number;
  endWithEnding: number;
}

const QUALIFIERS = [
  "public",
  "private",
  "internal",
  "protected",
  "static",
  "final",
  "override",
  "export",
  "async",
];
const TRAILING_DELIMITERS = ["->", "=>", ":=", "=", ":"];

export async function applyFileEdits(options: ApplyFileEditsOptions): Promise<EditSummary> {
  const config = options.config ?? defaultConfig;
  const modeCount = [
    options.rewrite !== undefined,
    options.edits !== undefined,
    options.search !== undefined || options.replace !== undefined,
  ].filter(Boolean).length;
  const pathResult = resolveWorkspacePath(options.roots, options.path);
  const summaryPath = "error" in pathResult ? options.path : pathResult.relativePath;
  if ("error" in pathResult) return errorSummary(summaryPath, pathResult.error);
  if (
    modeCount !== 1 ||
    ((options.search === undefined) !== (options.replace === undefined) &&
      options.rewrite === undefined &&
      options.edits === undefined)
  ) {
    return errorSummary(summaryPath, {
      code: "invalid_request",
      message: "Provide exactly one of rewrite, edits[], or search+replace.",
    });
  }

  if (options.rewrite !== undefined) {
    return applyRewrite(pathResult, options.rewrite, options, config);
  }

  const originalRaw = await readExisting(pathResult);
  if (originalRaw === null) {
    return errorSummary(summaryPath, { code: "not_found", path: summaryPath });
  }
  const pre_sha256 = sha256(originalRaw);
  if (options.expected_sha256 !== undefined && options.expected_sha256 !== pre_sha256) {
    return errorSummary(summaryPath, {
      code: "stale_file",
      expected_sha256: options.expected_sha256,
      actual_sha256: pre_sha256,
    });
  }
  const shape = textShape(originalRaw);
  const operations = options.edits ?? [
    { search: options.search ?? "", replace: options.replace ?? "", all: options.all },
  ];
  if (operations.length === 0) {
    return errorSummary(summaryPath, {
      code: "invalid_request",
      message: "edits array cannot be empty.",
    });
  }

  const resolved: ResolvedEdit[] = [];
  const matchedByByEdit = new Map<number, MatchedBy>();
  const diceScoresByEdit = new Map<number, number>();
  for (const [index, operation] of operations.entries()) {
    const resolution = resolveOperation(shape.normalized, operation, index);
    if ("error" in resolution) {
      return errorSummary(summaryPath, { ...resolution.error, edit_index: index } as EditError);
    }
    resolved.push(...resolution.edits);
    matchedByByEdit.set(index, resolution.matchedBy);
    if (resolution.diceScore !== undefined) diceScoresByEdit.set(index, resolution.diceScore);
  }

  const overlap = overlappingEdits(resolved);
  if (overlap) return errorSummary(summaryPath, overlap);

  const updatedNormalized = applyResolvedEdits(shape.normalized, resolved);
  const finalNormalized = preserveTrailingNewline(updatedNormalized, shape.hadTrailingNewline);
  const finalRaw = restoreLineEndings(finalNormalized, shape.lineEnding);
  const matched_by = operations.map((_, index) => matchedByByEdit.get(index) ?? "literal");
  const dice_scores = operations
    .map((_, index) => diceScoresByEdit.get(index))
    .filter((score): score is number => score !== undefined);
  const post_context = postContexts(finalNormalized, resolved);
  const base = {
    path: pathResult.relativePath,
    edits_applied: resolved.length,
    matched_by,
    file_created: false,
    dice_scores,
    pre_sha256,
    unified_diff: unifiedDiff(pathResult.relativePath, shape.normalized, finalNormalized),
  };
  if (options.dry_run) {
    return {
      status: "previewed",
      ...base,
      post_context,
    };
  }

  await writeFile(pathResult.absolutePath, finalRaw, "utf8");
  const postRaw = await readFile(pathResult.absolutePath, "utf8");
  const post_sha256 = sha256(postRaw);
  const verified = postRaw === finalRaw;
  if (!verified) {
    return {
      status: "error",
      ...base,
      post_sha256,
      verified: false,
      error: {
        code: "post_write_mismatch",
        expected_sha256: sha256(finalRaw),
        actual_sha256: post_sha256,
      },
    };
  }
  await postMutation(pathResult, config);

  return {
    status: "applied",
    ...base,
    post_sha256,
    verified: true,
    post_context,
  };
}

export async function fileAction(options: FileActionOptions): Promise<EditSummary> {
  const config = options.config ?? defaultConfig;
  const pathResult = resolveWorkspacePath(options.roots, options.path);
  if ("error" in pathResult) return errorSummary(options.path, pathResult.error);

  if (options.action === "create") {
    const exists = await existsPath(pathResult.absolutePath);
    if (exists && (options.if_exists ?? "error") !== "overwrite") {
      return errorSummary(pathResult.relativePath, {
        code: "already_exists",
        path: pathResult.relativePath,
      });
    }
    await mkdir(dirname(pathResult.absolutePath), { recursive: true });
    await writeFile(pathResult.absolutePath, options.content ?? "", "utf8");
    await postMutation(pathResult, config);
    return {
      status: "applied",
      path: pathResult.relativePath,
      edits_applied: 1,
      matched_by: ["rewrite"],
      file_created: !exists,
      dice_scores: [],
    };
  }

  if (options.action === "delete") {
    const originalRaw = await readExisting(pathResult);
    if (originalRaw === null) {
      return errorSummary(pathResult.relativePath, {
        code: "not_found",
        path: pathResult.relativePath,
      });
    }
    const pre_sha256 = sha256(originalRaw);
    if (options.expected_sha256 !== undefined && options.expected_sha256 !== pre_sha256) {
      return errorSummary(pathResult.relativePath, {
        code: "stale_file",
        expected_sha256: options.expected_sha256,
        actual_sha256: pre_sha256,
      });
    }
    await rm(pathResult.absolutePath, { force: true, recursive: false });
    await postMutation(pathResult, config);
    return {
      status: "applied",
      path: pathResult.relativePath,
      edits_applied: 1,
      matched_by: [],
      file_created: false,
      dice_scores: [],
      pre_sha256,
    };
  }

  if (!options.new_path) {
    return errorSummary(pathResult.relativePath, {
      code: "invalid_request",
      message: "new_path is required for move.",
    });
  }
  const newPath = resolveWorkspacePath(options.roots, options.new_path);
  if ("error" in newPath) return errorSummary(options.new_path, newPath.error);
  const originalRaw = await readExisting(pathResult);
  if (originalRaw === null) {
    return errorSummary(pathResult.relativePath, {
      code: "not_found",
      path: pathResult.relativePath,
    });
  }
  const pre_sha256 = sha256(originalRaw);
  if (options.expected_sha256 !== undefined && options.expected_sha256 !== pre_sha256) {
    return errorSummary(pathResult.relativePath, {
      code: "stale_file",
      expected_sha256: options.expected_sha256,
      actual_sha256: pre_sha256,
    });
  }
  if ((await existsPath(newPath.absolutePath)) && (options.if_exists ?? "error") !== "overwrite") {
    return errorSummary(newPath.relativePath, {
      code: "destination_exists",
      path: newPath.relativePath,
    });
  }
  await mkdir(dirname(newPath.absolutePath), { recursive: true });
  if ((options.if_exists ?? "error") === "overwrite") {
    await rm(newPath.absolutePath, { force: true }).catch(() => undefined);
  }
  await rename(pathResult.absolutePath, newPath.absolutePath);
  await postMutation(pathResult, config);
  await postMutation(newPath, config);
  return {
    status: "applied",
    path: newPath.relativePath,
    edits_applied: 1,
    matched_by: [],
    file_created: false,
    dice_scores: [],
    pre_sha256,
    note: `moved from ${pathResult.relativePath}`,
  };
}

export function resolveWorkspacePath(
  roots: string[],
  path: string,
): ResolvedPath | WorkspacePathError {
  for (const rootInput of roots.length > 0 ? roots : [process.cwd()]) {
    const root = resolve(rootInput);
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!relativePath.startsWith("..") && relativePath !== "" && !isAbsolute(relativePath)) {
      return { root, relativePath, absolutePath };
    }
  }
  return { error: { code: "outside_workspace", path } };
}

export function normalizeSelectorLine(raw: string): string {
  let value = raw
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const qualifier of QUALIFIERS) {
    if (value.startsWith(`${qualifier} `)) {
      value = value.slice(qualifier.length + 1);
      break;
    }
  }
  value = value.replace(/[-=_*~]{4,}/g, "-");
  if (value.length > 150) value = value.slice(0, 150);
  for (const delimiter of TRAILING_DELIMITERS) {
    if (value.endsWith(delimiter)) {
      value = value.slice(0, -delimiter.length).trimEnd();
      break;
    }
  }
  return value;
}

export function decodeEscapes(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\" || index === value.length - 1) {
      decoded += char;
      continue;
    }
    const next = value[index + 1];
    index += 1;
    if (next === "n") decoded += "\n";
    else if (next === "t") decoded += "\t";
    else if (next === "r") decoded += "\r";
    else if (next === "\\") decoded += "\\";
    else if (next === '"') decoded += '"';
    else decoded += `\\${next}`;
  }
  return decoded;
}

function resolveOperation(
  content: string,
  operation: EditOperation,
  editIndex: number,
): { edits: ResolvedEdit[]; matchedBy: MatchedBy; diceScore?: number } | { error: EditError } {
  if (operation.search.length === 0) {
    return { error: { code: "invalid_request", message: "search cannot be empty." } };
  }
  const literal = resolveLiteral(
    content,
    operation.search,
    operation.replace,
    operation.all,
    editIndex,
    "literal",
  );
  if (!("error" in literal) || literal.error.code !== "no_match") return literal;

  if (operation.search.includes("\\")) {
    const decodedSearch = decodeEscapes(operation.search);
    const decodedReplace = decodeEscapes(operation.replace);
    const escaped = resolveLiteral(
      content,
      decodedSearch,
      decodedReplace,
      operation.all,
      editIndex,
      "escape",
    );
    if (!("error" in escaped) || escaped.error.code !== "no_match") return escaped;
    return resolveFuzzy(content, decodedSearch, decodedReplace, editIndex);
  }

  return resolveFuzzy(content, operation.search, operation.replace, editIndex);
}

function resolveLiteral(
  content: string,
  search: string,
  replace: string,
  all: boolean | undefined,
  editIndex: number,
  matchedBy: MatchedBy,
): { edits: ResolvedEdit[]; matchedBy: MatchedBy } | { error: EditError } {
  const matches = findOccurrences(content, search);
  if (matches.length === 0)
    return { error: { code: "no_match", closest: closestLine(content, search) } };
  if (!all && matches.length > 1) {
    return {
      error: {
        code: "multiple_matches",
        lines: matches.map((offset) => lineNumber(content, offset)),
      },
    };
  }
  const selected = all ? matches : matches.slice(0, 1);
  return {
    matchedBy,
    edits: selected.map((startOffset) => ({
      editIndex,
      startOffset,
      endOffset: startOffset + search.length,
      startLine: lineNumber(content, startOffset),
      endLine: lineNumber(content, startOffset + search.length),
      replacement: replace,
      matchedBy,
      wholeLine: false,
    })),
  };
}

function resolveFuzzy(
  content: string,
  search: string,
  replace: string,
  editIndex: number,
): { edits: ResolvedEdit[]; matchedBy: MatchedBy; diceScore?: number } | { error: EditError } {
  const selectorLines = splitSelector(search);
  if (selectorLines.length === 0) {
    return {
      error: { code: "invalid_request", message: "search selector has no non-empty lines." },
    };
  }
  const normalizedSelector = selectorLines.map(normalizeSelectorLine);
  const fileLines = lineRecords(content);
  const normalizedFile = fileLines.map((line) => normalizeSelectorLine(line.text));
  const first = normalizedSelector[0] ?? "";
  let candidates = normalizedFile
    .map((line, index) => ({ line, index, score: diceCoefficient(first, line), fuzzy: false }))
    .filter((entry) => entry.line === first && first.length > 0);
  if (candidates.length === 0) {
    const threshold = adaptiveThreshold(first.length);
    candidates = normalizedFile
      .map((line, index) => ({ line, index, score: diceCoefficient(first, line), fuzzy: true }))
      .filter((entry) => entry.score >= threshold);
  }

  const closest = closestNormalizedLine(normalizedFile, first);
  const valid = candidates.filter((candidate) =>
    selectorPasses(normalizedSelector, normalizedFile, candidate.index, candidate.fuzzy),
  );
  const uniqueStarts = [...new Map(valid.map((entry) => [entry.index, entry])).values()];
  if (uniqueStarts.length === 0) return { error: { code: "no_match", closest } };
  if (uniqueStarts.length > 1) {
    return {
      error: {
        code: "ambiguous_match",
        candidates: uniqueStarts.map((entry) => entry.index + 1).sort((a, b) => a - b),
      },
    };
  }

  const match = uniqueStarts[0]!;
  const startLine = match.index + 1;
  const endLine = match.index + selectorLines.length;
  const startRecord = fileLines[match.index]!;
  const endRecord = fileLines[endLine - 1];
  if (!endRecord) return { error: { code: "no_match", closest } };
  const replacement = reanchorIndentation(
    replace.replace(/\r\n?/g, "\n"),
    selectorLines[0] ?? "",
    startRecord.text,
  );
  const finalReplacement =
    endRecord.endWithEnding > endRecord.end && !replacement.endsWith("\n")
      ? `${replacement}\n`
      : replacement;

  return {
    matchedBy: "fuzzy",
    diceScore: match.score,
    edits: [
      {
        editIndex,
        startOffset: startRecord.start,
        endOffset: endRecord.endWithEnding,
        startLine,
        endLine,
        replacement: finalReplacement,
        matchedBy: "fuzzy",
        diceScore: match.score,
        wholeLine: true,
      },
    ],
  };
}

function selectorPasses(
  selector: string[],
  file: string[],
  start: number,
  fuzzyFirstLine: boolean,
): boolean {
  if (start + selector.length > file.length) return false;
  const lineMatches = (offset: number) => {
    const expected = selector[offset] ?? "";
    const actual = file[start + offset] ?? "";
    if (actual === expected) return true;
    if (offset === 0 && fuzzyFirstLine)
      return diceCoefficient(expected, actual) >= adaptiveThreshold(expected.length);
    return false;
  };
  if (selector.length <= 2) return selector.every((_, offset) => lineMatches(offset));
  if (selector.length <= 5) return [0, 1, 2].every((offset) => lineMatches(offset));
  return (
    [0, 1, 2].every((offset) => lineMatches(offset)) &&
    [selector.length - 2, selector.length - 1].every((offset) => lineMatches(offset))
  );
}

function reanchorIndentation(
  replace: string,
  searchFirstLine: string,
  fileFirstLine: string,
): string {
  const searchIndent = leadingWhitespace(searchFirstLine);
  const fileIndent = leadingWhitespace(fileFirstLine);
  if (searchIndent === fileIndent) return replace;
  const replacementLines = replace.split("\n");
  if (fileIndent.startsWith(searchIndent)) {
    const delta = fileIndent.slice(searchIndent.length);
    return replacementLines
      .map((line) => (line.length === 0 ? line : `${delta}${line}`))
      .join("\n");
  }
  if (searchIndent.startsWith(fileIndent)) {
    const delta = searchIndent.slice(fileIndent.length);
    return replacementLines
      .map((line) => (line.startsWith(delta) ? line.slice(delta.length) : line))
      .join("\n");
  }
  const base = leadingWhitespace(replacementLines[0] ?? "");
  return replacementLines
    .map((line) => {
      if (line.length === 0) return line;
      if (line.startsWith(base)) return `${fileIndent}${line.slice(base.length)}`;
      return `${fileIndent}${line.trimStart()}`;
    })
    .join("\n");
}

function overlappingEdits(edits: ResolvedEdit[]): EditError | null {
  const sorted = [...edits].sort(
    (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.endOffset > current.startOffset) {
      return {
        code: "overlapping_edits",
        edit_indices: [...new Set([previous.editIndex, current.editIndex])].sort((a, b) => a - b),
      };
    }
  }
  return null;
}

function applyResolvedEdits(content: string, edits: ResolvedEdit[]): string {
  let updated = content;
  let delta = 0;
  for (const edit of [...edits].sort((a, b) => a.startOffset - b.startOffset)) {
    const start = edit.startOffset + delta;
    const end = edit.endOffset + delta;
    updated = `${updated.slice(0, start)}${edit.replacement}${updated.slice(end)}`;
    delta += edit.replacement.length - (edit.endOffset - edit.startOffset);
  }
  return updated;
}

function postContexts(content: string, edits: ResolvedEdit[]): EditPostContext[] {
  const contexts: EditPostContext[] = [];
  let delta = 0;
  for (const edit of [...edits].sort((a, b) => a.startOffset - b.startOffset)) {
    const finalStart = edit.startOffset + delta;
    const finalEnd = finalStart + edit.replacement.length;
    const startLine = lineNumber(content, finalStart);
    const endLine = lineNumber(content, Math.max(finalStart, finalEnd - 1));
    contexts.push(contextForLineRange(content, edit.editIndex, startLine, endLine));
    delta += edit.replacement.length - (edit.endOffset - edit.startOffset);
  }
  return contexts.sort((a, b) => a.edit_index - b.edit_index || a.start_line - b.start_line);
}

function rewritePostContext(content: string): EditPostContext[] {
  const total = Math.max(1, lineRecords(content).length);
  return [contextForLineRange(content, 0, 1, total)];
}

function contextForLineRange(
  content: string,
  editIndex: number,
  startLine: number,
  endLine: number,
): EditPostContext {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const safeStart = Math.max(1, startLine - 3);
  const safeEnd = Math.min(lines.length, endLine + 3);
  const text = lines
    .slice(safeStart - 1, safeEnd)
    .map((line, index) => `${safeStart + index}: ${line}`)
    .join("\n");
  return { edit_index: editIndex, start_line: startLine, end_line: endLine, text };
}

function textShape(raw: string): TextShape {
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const lf = (raw.match(/(?<!\r)\n/g)?.length ?? 0) + (raw.match(/\r(?!\n)/g)?.length ?? 0);
  const lineEnding: "\n" | "\r\n" = crlf > lf ? "\r\n" : "\n";
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { normalized, lineEnding, hadTrailingNewline: normalized.endsWith("\n") };
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\n" ? content : content.replace(/\n/g, "\r\n");
}

function preserveTrailingNewline(content: string, hadTrailingNewline: boolean): string {
  if (hadTrailingNewline) return content.endsWith("\n") ? content : `${content}\n`;
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function splitSelector(search: string): string[] {
  const lines = search.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.filter((line) => normalizeSelectorLine(line).length > 0);
}

function lineRecords(content: string): LineRecord[] {
  const records: LineRecord[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    records.push({
      text: content.slice(start, index),
      start,
      end: index,
      endWithEnding: index + 1,
    });
    start = index + 1;
  }
  if (start < content.length) {
    records.push({
      text: content.slice(start),
      start,
      end: content.length,
      endWithEnding: content.length,
    });
  }
  return records;
}

function findOccurrences(content: string, search: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const found = content.indexOf(search, cursor);
    if (found === -1) break;
    offsets.push(found);
    cursor = found + Math.max(search.length, 1);
  }
  return offsets;
}

function closestLine(content: string, search: string): { line: number; score: number } | null {
  return closestNormalizedLine(
    lineRecords(content).map((line) => normalizeSelectorLine(line.text)),
    normalizeSelectorLine(splitSelector(search)[0] ?? search),
  );
}

function closestNormalizedLine(
  lines: string[],
  selector: string,
): { line: number; score: number } | null {
  if (lines.length === 0) return null;
  let best = { line: 1, score: -1 };
  for (const [index, line] of lines.entries()) {
    const score = diceCoefficient(selector, line);
    if (score > best.score) best = { line: index + 1, score };
  }
  return { line: best.line, score: Number(best.score.toFixed(4)) };
}

function lineNumber(content: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, content.length);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === "\n") line += 1;
  }
  return line;
}

function adaptiveThreshold(length: number): number {
  if (length <= 4) return 0.25;
  if (length <= 7) return 0.35;
  if (length <= 12) return 0.5;
  if (length <= 20) return 0.65;
  if (length <= 40) return 0.7;
  return 0.8;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  let intersection = 0;
  const counts = new Map<string, number>();
  for (const gram of aBigrams) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  for (const gram of bBigrams) {
    const count = counts.get(gram) ?? 0;
    if (count <= 0) continue;
    intersection += 1;
    counts.set(gram, count - 1);
  }
  return (2 * intersection) / (aBigrams.length + bBigrams.length);
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.push(value.slice(index, index + 2));
  }
  return grams;
}

function leadingWhitespace(line: string): string {
  return line.match(/^\s*/)?.[0] ?? "";
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function applyRewrite(
  path: ResolvedPath,
  rewrite: string,
  options: ApplyFileEditsOptions,
  config: Config,
): Promise<EditSummary> {
  const existingRaw = await readExisting(path);
  const missing = existingRaw === null;
  if (missing && (options.on_missing ?? "error") !== "create") {
    return errorSummary(path.relativePath, { code: "not_found", path: path.relativePath });
  }
  const pre_sha256 = existingRaw === null ? sha256("") : sha256(existingRaw);
  if (!missing && options.expected_sha256 !== undefined && options.expected_sha256 !== pre_sha256) {
    return errorSummary(path.relativePath, {
      code: "stale_file",
      expected_sha256: options.expected_sha256,
      actual_sha256: pre_sha256,
    });
  }
  const finalText = missing
    ? rewrite
    : restoreLineEndings(
        preserveTrailingNewline(
          rewrite.replace(/\r\n?/g, "\n"),
          textShape(existingRaw).hadTrailingNewline,
        ),
        textShape(existingRaw).lineEnding,
      );
  const finalNormalized = finalText.replace(/\r\n/g, "\n");
  const base = {
    path: path.relativePath,
    edits_applied: 1,
    matched_by: ["rewrite" as const],
    file_created: missing,
    dice_scores: [],
    pre_sha256,
    unified_diff: unifiedDiff(path.relativePath, existingRaw ?? "", finalNormalized),
  };
  if (options.dry_run) {
    return {
      status: "previewed",
      ...base,
      post_context: rewritePostContext(finalNormalized),
    };
  }

  await mkdir(dirname(path.absolutePath), { recursive: true });
  await writeFile(path.absolutePath, finalText, "utf8");
  const postRaw = await readFile(path.absolutePath, "utf8");
  const post_sha256 = sha256(postRaw);
  const verified = postRaw === finalText;
  if (!verified) {
    return {
      status: "error",
      ...base,
      post_sha256,
      verified: false,
      error: {
        code: "post_write_mismatch",
        expected_sha256: sha256(finalText),
        actual_sha256: post_sha256,
      },
    };
  }
  await postMutation(path, config);
  return {
    status: "applied",
    ...base,
    post_sha256,
    verified: true,
    post_context: rewritePostContext(finalNormalized),
  };
}

async function readExisting(path: ResolvedPath): Promise<string | null> {
  try {
    return await readFile(path.absolutePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function existsPath(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function postMutation(path: ResolvedPath, config: Config): Promise<void> {
  invalidateCatalog();
  await invalidateCodemapCacheEntry(path.root, path.relativePath, config).catch(() => undefined);
}

function unifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = before.endsWith("\n") ? before.slice(0, -1).split("\n") : before.split("\n");
  const afterLines = after.endsWith("\n") ? after.slice(0, -1).split("\n") : after.split("\n");
  const lines = [`--- ${path}`, `+++ ${path}`, "@@"];
  for (const line of beforeLines) {
    if (!afterLines.includes(line)) lines.push(`-${line}`);
  }
  for (const line of afterLines) {
    if (!beforeLines.includes(line)) lines.push(`+${line}`);
  }
  return `${lines.join("\n")}\n`;
}

function errorSummary(path: string, error: EditError | WorkspacePathError["error"]): EditSummary {
  return {
    status: "error",
    path,
    edits_applied: 0,
    matched_by: [],
    file_created: false,
    error: error as EditError,
    dice_scores: [],
  };
}

function normalizePath(path: string): string {
  return path
    .split(sep)
    .join("/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}
