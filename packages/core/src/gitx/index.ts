import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config/index.js";
import { defaultConfig } from "../config/index.js";

const execFileAsync = promisify(execFile);

export type GitErrorCode = "not_a_repo" | "git_unavailable" | "git_error";
export type GitDetail = "summary" | "files" | "patches" | "full";

export interface GitToolError {
  code: GitErrorCode;
  message: string;
}

export interface GitStatusFile {
  path: string;
  state: "staged" | "unstaged" | "untracked" | "renamed" | "deleted";
  orig_path?: string;
}

export interface GitStatus {
  branch: string | null;
  head_sha: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
  totals: Record<GitStatusFile["state"], number>;
}

export interface GitDiffFile {
  path: string;
  old_path?: string;
  insertions: number;
  deletions: number;
  status: string;
  binary?: boolean;
  truncated?: boolean;
  omitted_lines?: number;
  hunks?: GitHunk[];
}

export interface GitHunk {
  header: string;
  oldStart: number;
  newStart: number;
  patch: string;
}

export type GitDiffResult =
  | { files: number; insertions: number; deletions: number }
  | { files: GitDiffFile[] };

export interface GitCommit {
  sha: string;
  short_sha: string;
  author: string;
  date_iso: string;
  subject: string;
}

export interface GitShowResult extends GitCommit {
  diff: GitDiffResult;
}

export interface GitBlameLine {
  line: number;
  sha_short: string;
  author: string;
  date_iso: string;
  content: string;
}

export interface GitDiffOptions {
  compare?: string;
  detail?: GitDetail;
  config?: Config;
}

export interface GitLogOptions {
  count?: number;
  path?: string;
}

export interface GitShowOptions {
  revspec?: string;
  detail?: GitDetail;
  config?: Config;
}

export interface GitBlameOptions {
  path: string;
  start_line?: number;
  end_line?: number;
}

interface GitExecOptions {
  diffSafety?: boolean;
  allowExitCodes?: number[];
}

interface ExecFailure {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

const ZERO_TOTALS: Record<GitStatusFile["state"], number> = {
  staged: 0,
  unstaged: 0,
  untracked: 0,
  renamed: 0,
  deleted: 0,
};

export async function gitStatus(roots: string[]): Promise<GitStatus> {
  const repo = await resolveRepoRoot(roots);
  const porcelain = await gitExec(repo, ["status", "--porcelain=v2", "--branch"]);
  const files: GitStatusFile[] = [];
  const totals = { ...ZERO_TOTALS };
  let branch: string | null = null;
  let head_sha: string | null = null;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length);
      head_sha = oid === "(initial)" ? null : oid;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    const parsed = parseStatusLine(line);
    for (const file of parsed) {
      files.push(file);
      totals[file.state] += 1;
    }
  }

  return {
    branch,
    head_sha,
    ...(upstream ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    files,
    totals,
  };
}

export async function gitDiff(
  roots: string[],
  options: GitDiffOptions = {},
): Promise<GitDiffResult> {
  const repo = await resolveRepoRoot(roots);
  const detail = options.detail ?? "summary";
  const diffArgs = await diffArgsForCompare(repo, options.compare ?? "uncommitted");
  return diffFromArgs(repo, diffArgs, detail, options.config ?? defaultConfig);
}

export async function gitLog(roots: string[], options: GitLogOptions = {}): Promise<GitCommit[]> {
  const repo = await resolveRepoRoot(roots);
  const count = String(options.count ?? 10);
  const args = ["log", `-${count}`, "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s"];
  if (options.path) args.push("--", options.path);
  const stdout = await gitExec(repo, args);
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(parseCommitLine);
}

export async function gitShow(
  roots: string[],
  options: GitShowOptions = {},
): Promise<GitShowResult> {
  const repo = await resolveRepoRoot(roots);
  const revspec = options.revspec ?? "HEAD";
  const meta = await gitExec(repo, [
    "show",
    "-s",
    "--date=iso-strict",
    "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s",
    revspec,
  ]);
  const diff = await diffFromArgs(
    repo,
    [`${revspec}^!`],
    options.detail ?? "summary",
    options.config ?? defaultConfig,
  );
  return { ...parseCommitLine(meta.trim()), diff };
}

export async function gitBlame(roots: string[], options: GitBlameOptions): Promise<GitBlameLine[]> {
  const repo = await resolveRepoRoot(roots);
  const lineRange =
    options.start_line !== undefined
      ? `${options.start_line},${options.end_line ?? options.start_line}`
      : undefined;
  const args = ["blame", "--line-porcelain"];
  if (lineRange) args.push("-L", lineRange);
  args.push("--", options.path);
  return parseBlame(await gitExec(repo, args));
}

export async function getDiffTextForPackager(
  roots: string[],
  compare = "uncommitted",
  maxLines = defaultConfig.caps.git_patch_lines,
): Promise<string> {
  const repo = await resolveRepoRoot(roots);
  const diffArgs = await diffArgsForCompare(repo, compare);
  const text = await gitExec(repo, ["diff", ...DIFF_SAFETY_FLAGS, ...diffArgs], {
    diffSafety: false,
  });
  return truncateText(text.trimEnd(), maxLines);
}

async function resolveRepoRoot(roots: string[]): Promise<string> {
  const root = roots[0] ?? process.cwd();
  try {
    return (await gitExec(root, ["rev-parse", "--show-toplevel"], { allowExitCodes: [] })).trim();
  } catch (error) {
    const mapped = mapGitError(error);
    if (mapped.code === "git_error") {
      throw { code: "not_a_repo", message: `No git repository found from ${root}.` };
    }
    throw mapped;
  }
}

const DIFF_SAFETY_FLAGS = ["--no-ext-diff", "--no-textconv", "--color=never"];

async function gitExec(cwd: string, args: string[], options: GitExecOptions = {}): Promise<string> {
  const finalArgs = ["--no-pager", "-C", cwd, ...args];
  try {
    const { stdout } = await execFileAsync("git", finalArgs, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as ExecFailure;
    if (options.allowExitCodes?.includes(Number(failure.code))) {
      return failure.stdout ?? "";
    }
    throw mapGitError(error);
  }
}

function mapGitError(error: unknown): GitToolError {
  const failure = error as ExecFailure;
  if (failure.code === "ENOENT") {
    return { code: "git_unavailable", message: "git executable is not available." };
  }
  const stderr = failure.stderr ?? "";
  if (/not a git repository|not a git dir|outside repository/i.test(stderr)) {
    return { code: "not_a_repo", message: stderr.trim() || "Not a git repository." };
  }
  return {
    code: "git_error",
    message: stderr.trim() || failure.message || "git command failed.",
  };
}

function parseStatusLine(line: string): GitStatusFile[] {
  if (line.startsWith("? ")) return [{ path: line.slice(2), state: "untracked" }];
  if (line.startsWith("1 ")) {
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const path = parts.slice(8).join(" ");
    return statusEntries(path, xy);
  }
  if (line.startsWith("2 ")) {
    const tab = line.indexOf("\t");
    const meta = tab >= 0 ? line.slice(0, tab).split(" ") : line.split(" ");
    const xy = meta[1] ?? "..";
    const path = meta[9] ?? "";
    const orig_path = tab >= 0 ? line.slice(tab + 1) : undefined;
    return [{ path, state: "renamed", ...(orig_path ? { orig_path } : {}) }];
  }
  return [];
}

function statusEntries(path: string, xy: string): GitStatusFile[] {
  const entries: GitStatusFile[] = [];
  const [x = ".", y = "."] = xy.split("");
  if (x !== "." && x !== " ") {
    entries.push({ path, state: x === "D" ? "deleted" : "staged" });
  }
  if (y !== "." && y !== " ") {
    entries.push({ path, state: y === "D" ? "deleted" : "unstaged" });
  }
  return entries;
}

async function diffArgsForCompare(repo: string, compare: string): Promise<string[]> {
  if (compare === "uncommitted") return ["HEAD"];
  if (compare === "staged") return ["--cached"];
  if (compare === "unstaged") return [];
  const back = /^back:(\d+)$/.exec(compare);
  if (back) return [`HEAD~${back[1]}..HEAD`];
  const mergebase = /^mergebase:(.+)$/.exec(compare);
  if (mergebase) return [await mergeBase(repo, mergebase[1]!)];
  if (compare === "main" || compare === "trunk")
    return [await mergeBase(repo, await detectTrunk(repo))];
  return [compare];
}

async function detectTrunk(repo: string): Promise<string> {
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    try {
      await gitExec(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      // Try the next trunk candidate.
    }
  }
  throw { code: "git_error", message: "Unable to detect trunk ref." } satisfies GitToolError;
}

async function mergeBase(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["merge-base", ref, "HEAD"])).trim();
}

async function diffFromArgs(
  repo: string,
  diffArgs: string[],
  detail: GitDetail,
  config: Config,
): Promise<GitDiffResult> {
  if (detail === "summary") {
    return parseShortStat(
      await gitExec(repo, ["diff", ...DIFF_SAFETY_FLAGS, "--shortstat", ...diffArgs]),
    );
  }
  const files = await parseFiles(repo, diffArgs);
  if (detail === "files") return { files };
  const patch = await gitExec(repo, ["diff", ...DIFF_SAFETY_FLAGS, ...diffArgs]);
  return {
    files: attachPatches(
      files,
      patch,
      detail === "patches" ? config.caps.git_patch_lines : undefined,
    ),
  };
}

async function parseFiles(repo: string, diffArgs: string[]): Promise<GitDiffFile[]> {
  const [numstat, nameStatus] = await Promise.all([
    gitExec(repo, ["diff", ...DIFF_SAFETY_FLAGS, "--numstat", ...diffArgs]),
    gitExec(repo, ["diff", ...DIFF_SAFETY_FLAGS, "--name-status", ...diffArgs]),
  ]);
  const stats = new Map<string, Pick<GitDiffFile, "insertions" | "deletions" | "binary">>();
  for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
    const [insertions, deletions, path] = line.split("\t");
    if (!path) continue;
    stats.set(path, {
      insertions: insertions === "-" ? 0 : Number(insertions),
      deletions: deletions === "-" ? 0 : Number(deletions),
      ...(insertions === "-" || deletions === "-" ? { binary: true } : {}),
    });
  }
  return nameStatus
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [statusRaw = "", first = "", second] = line.split("\t");
      const status = statusRaw[0] ?? "";
      const path = second ?? first;
      const old_path = second ? first : undefined;
      const stat = stats.get(path) ?? { insertions: 0, deletions: 0 };
      return { path, ...(old_path ? { old_path } : {}), status, ...stat };
    });
}

function parseShortStat(text: string): { files: number; insertions: number; deletions: number } {
  return {
    files: Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0),
    insertions: Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0),
    deletions: Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0),
  };
}

function attachPatches(
  files: GitDiffFile[],
  patchText: string,
  maxLines: number | undefined,
): GitDiffFile[] {
  const parsed = parseUnifiedPatch(patchText, maxLines);
  return files.map((file) => {
    const patch = parsed.get(file.path);
    return {
      ...file,
      binary: file.binary || patch?.binary || undefined,
      truncated: patch?.truncated ?? false,
      omitted_lines: patch?.omitted_lines ?? 0,
      hunks: patch?.hunks ?? [],
    };
  });
}

function parseUnifiedPatch(
  text: string,
  maxLines: number | undefined,
): Map<string, { binary?: boolean; truncated: boolean; omitted_lines: number; hunks: GitHunk[] }> {
  const result = new Map<
    string,
    { binary?: boolean; truncated: boolean; omitted_lines: number; hunks: GitHunk[] }
  >();
  const lines = text.split(/\r?\n/);
  let path: string | null = null;
  let current:
    | { binary?: boolean; truncated: boolean; omitted_lines: number; hunks: GitHunk[] }
    | undefined;
  let hunk: GitHunk | undefined;
  let filePatchLines = 0;

  function addPatchLine(line: string): void {
    if (!current || !hunk) return;
    filePatchLines += 1;
    if (maxLines !== undefined && filePatchLines > maxLines) {
      current.truncated = true;
      current.omitted_lines += 1;
      return;
    }
    hunk.patch += hunk.patch ? `\n${line}` : line;
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      path = line.match(/^diff --git a\/(.+) b\/(.+)$/)?.[2] ?? null;
      if (path) {
        current = { truncated: false, omitted_lines: 0, hunks: [] };
        result.set(path, current);
        hunk = undefined;
        filePatchLines = 0;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      hunk = {
        header: line,
        oldStart: Number(match?.[1] ?? 0),
        newStart: Number(match?.[2] ?? 0),
        patch: "",
      };
      current.hunks.push(hunk);
      addPatchLine(line);
      continue;
    }
    if (hunk) addPatchLine(line);
  }
  return result;
}

function parseCommitLine(line: string): GitCommit {
  const [sha = "", short_sha = "", author = "", date_iso = "", subject = ""] = line.split("\x1f");
  return { sha, short_sha, author, date_iso, subject };
}

function parseBlame(text: string): GitBlameLine[] {
  const lines = text.split(/\r?\n/);
  const result: GitBlameLine[] = [];
  let current:
    | { sha: string; line: number; author: string; date: string; content?: string }
    | undefined;
  for (const line of lines) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) {
      current = { sha: header[1]!, line: Number(header[2]), author: "", date: "" };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("author ")) current.author = line.slice("author ".length);
    if (line.startsWith("author-time ")) {
      current.date = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    }
    if (line.startsWith("\t")) {
      result.push({
        line: current.line,
        sha_short: current.sha.slice(0, 7),
        author: current.author,
        date_iso: current.date,
        content: line.slice(1),
      });
      current = undefined;
    }
  }
  return result;
}

function truncateText(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n... [diff truncated: ${omitted} more lines]`;
}
