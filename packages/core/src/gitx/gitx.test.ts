import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { getDiffTextForPackager, gitBlame, gitDiff, gitLog, gitShow, gitStatus } from "./index.js";

const execFileAsync = promisify(execFile);

async function tempRoot(name = "gitx"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(root: string, path: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function initRepo(name = "gitx"): Promise<string> {
  const root = await tempRoot(name);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

function withConfig(overrides: DeepPartial<Config> = {}): Config {
  const config = structuredClone(defaultConfig);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  return config;
}

describe("gitStatus", () => {
  it("parses porcelain v2 dirty, staged, untracked, renamed, and deleted files", async () => {
    const root = await initRepo("status");
    await write(root, "staged.txt", "old\n");
    await write(root, "dirty.txt", "old\n");
    await write(root, "old-name.txt", "old\n");
    await write(root, "deleted.txt", "old\n");
    const head = await commitAll(root, "base");

    await write(root, "staged.txt", "new\n");
    await git(root, ["add", "staged.txt"]);
    await write(root, "dirty.txt", "new\n");
    await write(root, "untracked.txt", "new\n");
    await rename(join(root, "old-name.txt"), join(root, "new-name.txt"));
    await git(root, ["add", "-A", "old-name.txt", "new-name.txt"]);
    await rm(join(root, "deleted.txt"));

    const status = await gitStatus([root]);

    expect(status).toMatchObject({
      branch: "main",
      head_sha: head,
      totals: { staged: 1, unstaged: 1, untracked: 1, renamed: 1, deleted: 1 },
    });
    expect(status.files).toEqual(
      expect.arrayContaining([
        { path: "staged.txt", state: "staged" },
        { path: "dirty.txt", state: "unstaged" },
        { path: "untracked.txt", state: "untracked" },
        { path: "new-name.txt", state: "renamed", orig_path: "old-name.txt" },
        { path: "deleted.txt", state: "deleted" },
      ]),
    );
  });

  it("returns structured not_a_repo errors", async () => {
    const root = await tempRoot("not-repo");
    await expect(gitStatus([root])).rejects.toMatchObject({
      code: "not_a_repo",
    });
  });
});

describe("gitDiff", () => {
  it("supports uncommitted summary, files, structured patches, and patch truncation", async () => {
    const root = await initRepo("diff-uncommitted");
    await write(root, "src/a.ts", "one\ntwo\nthree\n");
    await commitAll(root, "base");
    await write(root, "src/a.ts", "one\nTWO\nthree\nfour\n");

    const summary = await gitDiff([root], { detail: "summary" });
    expect(summary).toMatchObject({ files: 1, insertions: 2, deletions: 1 });

    const files = await gitDiff([root], { detail: "files" });
    expect(files.files).toEqual([{ path: "src/a.ts", insertions: 2, deletions: 1, status: "M" }]);

    const patches = (await gitDiff([root], {
      detail: "patches",
      config: withConfig({ caps: { git_patch_lines: 6 } }),
    })) as {
      files: Array<{
        path: string;
        truncated: boolean;
        omitted_lines: number;
        hunks: Array<{ header: string; oldStart: number; newStart: number; patch: string }>;
      }>;
    };
    expect(patches.files[0]).toMatchObject({
      path: "src/a.ts",
      truncated: true,
      omitted_lines: expect.any(Number),
      hunks: [{ oldStart: 1, newStart: 1 }],
    });
    expect(patches.files[0]!.hunks[0]!.header).toContain("@@");
    expect(patches.files[0]!.hunks[0]!.patch).toContain("-two");

    const full = (await gitDiff([root], { detail: "full" })) as {
      files: Array<{
        truncated: boolean;
        omitted_lines: number;
        hunks: Array<{ patch: string }>;
      }>;
    };
    expect(full.files[0]).toMatchObject({ truncated: false, omitted_lines: 0 });
    expect(full.files[0]!.hunks[0]!.patch).toContain("+four");
  });

  it("supports staged, back:N, mergebase:<ref>, and binary file flags", async () => {
    const stagedRoot = await initRepo("diff-staged");
    await write(stagedRoot, "a.txt", "a\n");
    await commitAll(stagedRoot, "base");
    await write(stagedRoot, "a.txt", "a staged\n");
    await git(stagedRoot, ["add", "a.txt"]);
    expect(await gitDiff([stagedRoot], { compare: "staged", detail: "summary" })).toMatchObject({
      files: 1,
      insertions: 1,
      deletions: 1,
    });

    const backRoot = await initRepo("diff-back");
    await write(backRoot, "a.txt", "one\n");
    await commitAll(backRoot, "base");
    await write(backRoot, "a.txt", "one\ntwo\n");
    await commitAll(backRoot, "second");
    expect(await gitDiff([backRoot], { compare: "back:1", detail: "files" })).toMatchObject({
      files: [{ path: "a.txt", insertions: 1, deletions: 0, status: "M" }],
    });

    const mergeRoot = await initRepo("diff-mergebase");
    await write(mergeRoot, "base.txt", "base\n");
    await commitAll(mergeRoot, "base");
    await git(mergeRoot, ["checkout", "-b", "feature"]);
    await write(mergeRoot, "feature.txt", "feature\n");
    await commitAll(mergeRoot, "feature");
    expect(
      await gitDiff([mergeRoot], { compare: "mergebase:main", detail: "files" }),
    ).toMatchObject({
      files: [{ path: "feature.txt", insertions: 1, deletions: 0, status: "A" }],
    });

    const binaryRoot = await initRepo("diff-binary");
    await write(binaryRoot, "image.bin", Buffer.from([0, 1, 2, 3]));
    await commitAll(binaryRoot, "base");
    await write(binaryRoot, "image.bin", Buffer.from([0, 1, 9, 3]));
    const binary = (await gitDiff([binaryRoot], { detail: "patches" })) as {
      files: Array<{ path: string; binary?: boolean }>;
    };
    expect(binary.files[0]).toMatchObject({ path: "image.bin", binary: true });
  });
});

describe("git log, show, blame, and packager diff text", () => {
  it("returns recent commits with path filtering", async () => {
    const root = await initRepo("log");
    await write(root, "a.txt", "a\n");
    const first = await commitAll(root, "first");
    await write(root, "b.txt", "b\n");
    const second = await commitAll(root, "second");

    const all = await gitLog([root], { count: 2 });
    expect(all.map((entry) => entry.sha)).toEqual([second, first]);
    expect(all[0]).toMatchObject({
      short_sha: second.slice(0, 7),
      author: "Test User",
      subject: "second",
    });

    const filtered = await gitLog([root], { count: 10, path: "a.txt" });
    expect(filtered.map((entry) => entry.subject)).toEqual(["first"]);
  });

  it("returns show metadata plus requested diff detail", async () => {
    const root = await initRepo("show");
    await write(root, "a.txt", "a\n");
    await commitAll(root, "base");
    await write(root, "a.txt", "a\nb\n");
    const sha = await commitAll(root, "second");

    const shown = await gitShow([root], { revspec: sha, detail: "files" });
    expect(shown).toMatchObject({
      sha,
      short_sha: sha.slice(0, 7),
      author: "Test User",
      subject: "second",
      diff: { files: [{ path: "a.txt", insertions: 1, deletions: 0, status: "M" }] },
    });
  });

  it("returns blame line porcelain ranges", async () => {
    const root = await initRepo("blame");
    await write(root, "a.txt", "one\ntwo\nthree\n");
    await commitAll(root, "base");

    const blame = await gitBlame([root], { path: "a.txt", start_line: 2, end_line: 3 });
    expect(blame).toHaveLength(2);
    expect(blame[0]).toMatchObject({ author: "Test User", content: "two" });
    expect(blame[0]!.sha_short).toHaveLength(7);
    expect(blame[0]!.date_iso).toMatch(/T/);
  });

  it("returns truncated unified diff text for packager integration", async () => {
    const root = await initRepo("packager-diff");
    await write(root, "a.txt", "one\ntwo\nthree\n");
    await commitAll(root, "base");
    await write(root, "a.txt", "one\nTWO\nthree\nfour\n");

    const text = await getDiffTextForPackager([root], "uncommitted", 8);
    expect(text).toContain("diff --git a/a.txt b/a.txt");
    expect(text).toContain("-two");
    expect(text).toContain("... [diff truncated:");
  });
});
