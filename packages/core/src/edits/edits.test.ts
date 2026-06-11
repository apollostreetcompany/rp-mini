import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig } from "../config/index.js";
import { getCodeStructures, warmCodemapCache } from "../codemaps/index.js";
import {
  applyFileEdits,
  decodeEscapes,
  fileAction,
  normalizeSelectorLine,
  resolveWorkspacePath,
} from "./index.js";

async function tempRoot(name = "edits"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function read(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("edit selector normalization", () => {
  it("normalizes lines like the CE matching ladder subset", () => {
    expect(normalizeSelectorLine("  public   Foo\u00A0Bar   ->  ")).toBe("foo bar");
    expect(normalizeSelectorLine("EXPORT async   handler   =>")).toBe("async handler");
    expect(normalizeSelectorLine("///// ----- _____ *****")).toBe("///// - - -");
    expect(normalizeSelectorLine("x".repeat(200))).toHaveLength(150);
  });

  it("decodes only C-style escapes used by the escape fallback", () => {
    expect(decodeEscapes(String.raw`one\ntwo\t\"x\"\\`)).toBe('one\ntwo\t"x"\\');
  });
});

describe("applyFileEdits literal and escape tiers", () => {
  it("applies a unique literal replacement", async () => {
    const root = await tempRoot("literal");
    await write(root, "src/a.ts", "one\ntwo\nthree\n");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "two",
      replace: "TWO",
    });

    expect(result).toMatchObject({
      status: "applied",
      edits_applied: 1,
      matched_by: ["literal"],
      file_created: false,
    });
    expect(await read(root, "src/a.ts")).toBe("one\nTWO\nthree\n");
  });

  it("previews dry_run edits with diff and pre_sha256 without touching disk", async () => {
    const root = await tempRoot("dry-run");
    const original = "one\ntwo\nthree\n";
    await write(root, "src/a.ts", original);

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "two",
      replace: "TWO",
      dry_run: true,
    });

    expect(result).toMatchObject({
      status: "previewed",
      edits_applied: 1,
      matched_by: ["literal"],
      file_created: false,
    });
    expect(result.unified_diff).toContain("+TWO");
    expect(result.pre_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.post_context?.[0]?.text).toContain("TWO");
    expect(await read(root, "src/a.ts")).toBe(original);
  });

  it("applies preview handshakes with expected_sha256 and returns post-write proof", async () => {
    const root = await tempRoot("hash-handshake");
    await write(root, "src/a.ts", "one\ntwo\nthree\n");

    const preview = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "two",
      replace: "TWO",
      dry_run: true,
    });
    const applied = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "two",
      replace: "TWO",
      expected_sha256: preview.pre_sha256,
    });

    expect(applied).toMatchObject({
      status: "applied",
      verified: true,
      pre_sha256: preview.pre_sha256,
      edits_applied: 1,
    });
    expect(applied.post_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(applied.post_sha256).not.toBe(preview.pre_sha256);
    expect(applied.post_context?.[0]?.text).toContain("2: TWO");
    expect(await read(root, "src/a.ts")).toBe("one\nTWO\nthree\n");
  });

  it("rejects stale expected_sha256 before matching and leaves the file untouched", async () => {
    const root = await tempRoot("stale");
    await write(root, "src/a.ts", "one\ntwo\nthree\n");

    const preview = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "two",
      replace: "TWO",
      dry_run: true,
    });
    await write(root, "src/a.ts", "one\nchanged\nthree\n");
    const stale = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "changed",
      replace: "CHANGED",
      expected_sha256: preview.pre_sha256,
    });

    expect(stale).toMatchObject({
      status: "error",
      error: {
        code: "stale_file",
        expected_sha256: preview.pre_sha256,
      },
    });
    expect(stale.error && "actual_sha256" in stale.error ? stale.error.actual_sha256 : "").toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(await read(root, "src/a.ts")).toBe("one\nchanged\nthree\n");
  });

  it("fails closed on multiple literal matches unless all is true", async () => {
    const root = await tempRoot("literal-multi");
    await write(root, "src/a.ts", "dup\nx\ndup\n");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "dup",
      replace: "done",
    });

    expect(result).toMatchObject({
      status: "error",
      error: { code: "multiple_matches", lines: [1, 3] },
    });
    expect(await read(root, "src/a.ts")).toBe("dup\nx\ndup\n");

    const all = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "dup",
      replace: "done",
      all: true,
    });
    expect(all).toMatchObject({ status: "applied", edits_applied: 2, matched_by: ["literal"] });
    expect(await read(root, "src/a.ts")).toBe("done\nx\ndone\n");
  });

  it("uses escape-decode only when the search contains a backslash", async () => {
    const root = await tempRoot("escape");
    await write(root, "src/a.ts", "before\nalpha\nbeta\nafter\n");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: String.raw`alpha\nbeta`,
      replace: String.raw`ALPHA\nBETA`,
    });

    expect(result).toMatchObject({ status: "applied", matched_by: ["escape"] });
    expect(await read(root, "src/a.ts")).toBe("before\nALPHA\nBETA\nafter\n");
  });
});

describe("applyFileEdits fuzzy tier", () => {
  it("matches whitespace, case, qualifier drift, and typo drift within threshold", async () => {
    const root = await tempRoot("fuzzy-basic");
    await write(
      root,
      "src/a.ts",
      ["export function calculateTotal(value: number) {", "  return value + 1;", "}", ""].join(
        "\n",
      ),
    );

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: ["PRIVATE FUNCTION calculateTotel(value:   number) {", "return value + 1;", "}"].join(
        "\n",
      ),
      replace: ["function calculateTotal(value: number) {", "  return value + 2;", "}"].join("\n"),
    });

    expect(result.status).toBe("applied");
    expect(result.matched_by).toEqual(["fuzzy"]);
    expect(result.dice_scores[0]).toBeGreaterThanOrEqual(0.7);
    expect(await read(root, "src/a.ts")).toContain("return value + 2;");
  });

  it("reports no_match with closest line and score when fuzzy threshold fails", async () => {
    const root = await tempRoot("fuzzy-no-match");
    await write(root, "src/a.ts", "alpha beta gamma\n");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "zzzzzzzzzzzzzz",
      replace: "nope",
    });

    expect(result).toMatchObject({
      status: "error",
      error: { code: "no_match", closest: { line: 1 } },
    });
    expect(await read(root, "src/a.ts")).toBe("alpha beta gamma\n");
  });

  it("fails ambiguous fuzzy matches with all candidate lines and leaves bytes untouched", async () => {
    const root = await tempRoot("fuzzy-ambiguous");
    const original = [
      "function renderCard() {",
      "  return 'a';",
      "}",
      "function renderCard() {",
      "  return 'b';",
      "}",
      "",
    ].join("\n");
    await write(root, "src/a.ts", original);

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "private function renderCard() {",
      replace: "function renderCardRenamed() {",
    });

    expect(result).toMatchObject({
      status: "error",
      error: { code: "ambiguous_match", candidates: [1, 4] },
    });
    expect(await read(root, "src/a.ts")).toBe(original);
  });

  it("re-anchors replacement indentation for spaces and tabs", async () => {
    const spaces = await tempRoot("indent-spaces");
    await write(spaces, "src/a.ts", "if (ok) {\n    callThing();\n}\n");
    const spaceResult = await applyFileEdits({
      roots: [spaces],
      path: "src/a.ts",
      search: "private callThing();",
      replace: "callThing();\nlogThing();",
    });
    expect(spaceResult.status).toBe("applied");
    expect(await read(spaces, "src/a.ts")).toBe(
      "if (ok) {\n    callThing();\n    logThing();\n}\n",
    );

    const tabs = await tempRoot("indent-tabs");
    await write(tabs, "src/a.ts", "if (ok) {\n\tcallThing();\n}\n");
    const tabResult = await applyFileEdits({
      roots: [tabs],
      path: "src/a.ts",
      search: "private callThing();",
      replace: "callThing();\nlogThing();",
    });
    expect(tabResult.status).toBe("applied");
    expect(await read(tabs, "src/a.ts")).toBe("if (ok) {\n\tcallThing();\n\tlogThing();\n}\n");
  });

  it("uses medium three-head-line and long head-plus-tail rules", async () => {
    const medium = await tempRoot("medium");
    await write(medium, "src/a.txt", "a\nb\nc\nDIFFERENT\nz\n");
    const mediumResult = await applyFileEdits({
      roots: [medium],
      path: "src/a.txt",
      search: "a\nb\nc\nd",
      replace: "m1\nm2",
    });
    expect(mediumResult.status).toBe("applied");
    expect(await read(medium, "src/a.txt")).toBe("m1\nm2\nz\n");

    const long = await tempRoot("long");
    await write(long, "src/a.txt", "h1\nh2\nh3\nfile middle one\nfile middle two\ntail1\ntail2\n");
    const longResult = await applyFileEdits({
      roots: [long],
      path: "src/a.txt",
      search: "h1\nh2\nh3\nsearch middle one\nsearch middle two\ntail1\ntail2",
      replace: "long done",
    });
    expect(longResult.status).toBe("applied");
    expect(await read(long, "src/a.txt")).toBe("long done\n");
  });
});

describe("applyFileEdits batch, rewrite, endings, and unicode", () => {
  it("validates a batch against original content and applies line-delta shifts", async () => {
    const root = await tempRoot("batch");
    await write(root, "src/a.txt", "one\ntwo\nthree\nfour\nfive\n");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.txt",
      edits: [
        { search: "one", replace: "zero\none" },
        { search: "three\nfour", replace: "THREE" },
        { search: "five", replace: "FIVE" },
      ],
    });

    expect(result).toMatchObject({
      status: "applied",
      edits_applied: 3,
      matched_by: ["literal", "literal", "literal"],
    });
    expect(await read(root, "src/a.txt")).toBe("zero\none\ntwo\nTHREE\nFIVE\n");
  });

  it("rejects overlapping batch spans and failing batch edits without writing", async () => {
    const root = await tempRoot("batch-fail");
    const original = "alpha\nbeta\ngamma\n";
    await write(root, "src/a.txt", original);

    const overlap = await applyFileEdits({
      roots: [root],
      path: "src/a.txt",
      edits: [
        { search: "alpha\nbeta", replace: "x" },
        { search: "beta\ngamma", replace: "y" },
      ],
    });
    expect(overlap).toMatchObject({ status: "error", error: { code: "overlapping_edits" } });
    expect(await read(root, "src/a.txt")).toBe(original);

    const failing = await applyFileEdits({
      roots: [root],
      path: "src/a.txt",
      edits: [
        { search: "alpha", replace: "x" },
        { search: "missing", replace: "y" },
      ],
    });
    expect(failing).toMatchObject({ status: "error", error: { edit_index: 1 } });
    expect(await read(root, "src/a.txt")).toBe(original);
  });

  it("previews transactional batches without writing and hash-gates batch applies", async () => {
    const root = await tempRoot("batch-preview");
    const original = "one\ntwo\nthree\nfour\nfive\n";
    await write(root, "src/a.txt", original);

    const preview = await applyFileEdits({
      roots: [root],
      path: "src/a.txt",
      edits: [
        { search: "one", replace: "zero\none" },
        { search: "three\nfour", replace: "THREE" },
        { search: "five", replace: "FIVE" },
      ],
      dry_run: true,
    });

    expect(preview).toMatchObject({
      status: "previewed",
      edits_applied: 3,
      matched_by: ["literal", "literal", "literal"],
    });
    expect(preview.unified_diff).toContain("+THREE");
    expect(await read(root, "src/a.txt")).toBe(original);

    await write(root, "src/a.txt", "one\ntwo\nchanged\nfour\nfive\n");
    const stale = await applyFileEdits({
      roots: [root],
      path: "src/a.txt",
      edits: [
        { search: "one", replace: "zero\none" },
        { search: "changed\nfour", replace: "CHANGED" },
      ],
      expected_sha256: preview.pre_sha256,
    });
    expect(stale).toMatchObject({ status: "error", error: { code: "stale_file" } });
    expect(await read(root, "src/a.txt")).toBe("one\ntwo\nchanged\nfour\nfive\n");
  });

  it("supports rewrite create/error modes, CRLF preservation, trailing newline, unicode, and idempotence", async () => {
    const root = await tempRoot("rewrite");
    const missing = await applyFileEdits({
      roots: [root],
      path: "src/new.txt",
      rewrite: "created\n",
      on_missing: "error",
    });
    expect(missing).toMatchObject({ status: "error", error: { code: "not_found" } });

    const created = await applyFileEdits({
      roots: [root],
      path: "src/new.txt",
      rewrite: "created\n",
      on_missing: "create",
    });
    expect(created).toMatchObject({ status: "applied", file_created: true });
    expect(await read(root, "src/new.txt")).toBe("created\n");

    await write(root, "src/crlf.txt", "one\r\ntwo\r\n");
    const crlf = await applyFileEdits({
      roots: [root],
      path: "src/crlf.txt",
      search: "two",
      replace: "emoji 😀",
    });
    expect(crlf.status).toBe("applied");
    expect(await read(root, "src/crlf.txt")).toBe("one\r\nemoji 😀\r\n");

    const again = await applyFileEdits({
      roots: [root],
      path: "src/crlf.txt",
      search: "two",
      replace: "emoji 😀",
    });
    expect(again).toMatchObject({ status: "error", error: { code: "no_match" } });

    const rewritePreview = await applyFileEdits({
      roots: [root],
      path: "src/crlf.txt",
      rewrite: "whole\nfile\n",
      dry_run: true,
    });
    expect(rewritePreview).toMatchObject({ status: "previewed", matched_by: ["rewrite"] });
    expect(await read(root, "src/crlf.txt")).toBe("one\r\nemoji 😀\r\n");
  });

  it("returns a unified diff when verbose is true", async () => {
    const root = await tempRoot("diff");
    await write(root, "src/a.txt", "old\n");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.txt",
      search: "old",
      replace: "new",
      verbose: true,
    });

    expect(result.unified_diff).toContain("--- src/a.txt");
    expect(result.unified_diff).toContain("+new");
  });
});

describe("fileAction", () => {
  it("creates, guards overwrites, deletes, moves, and rejects outside workspace paths", async () => {
    const root = await tempRoot("actions");
    const create = await fileAction({
      roots: [root],
      action: "create",
      path: "src/a.txt",
      content: "one\n",
    });
    expect(create).toMatchObject({ status: "applied", path: "src/a.txt", file_created: true });
    expect(await read(root, "src/a.txt")).toBe("one\n");

    const guarded = await fileAction({
      roots: [root],
      action: "create",
      path: "src/a.txt",
      content: "two\n",
    });
    expect(guarded).toMatchObject({ status: "error", error: { code: "already_exists" } });

    const overwritten = await fileAction({
      roots: [root],
      action: "create",
      path: "src/a.txt",
      content: "two\n",
      if_exists: "overwrite",
    });
    expect(overwritten.status).toBe("applied");
    expect(await read(root, "src/a.txt")).toBe("two\n");

    const moved = await fileAction({
      roots: [root],
      action: "move",
      path: "src/a.txt",
      new_path: "src/b.txt",
    });
    expect(moved).toMatchObject({ status: "applied", path: "src/b.txt" });
    expect(await read(root, "src/b.txt")).toBe("two\n");

    const deleted = await fileAction({ roots: [root], action: "delete", path: "src/b.txt" });
    expect(deleted).toMatchObject({ status: "applied", edits_applied: 1 });
    await expect(stat(join(root, "src/b.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    expect(resolveWorkspacePath([root], "../outside.txt")).toMatchObject({
      error: { code: "outside_workspace" },
    });
    const outside = await fileAction({
      roots: [root],
      action: "create",
      path: "../outside.txt",
      content: "x",
    });
    expect(outside).toMatchObject({ status: "error", error: { code: "outside_workspace" } });
  });

  it("hash-gates delete and move actions", async () => {
    const root = await tempRoot("actions-stale");
    await write(root, "src/delete.txt", "delete me\n");
    await write(root, "src/move.txt", "move me\n");

    const deletePreview = await applyFileEdits({
      roots: [root],
      path: "src/delete.txt",
      rewrite: "delete me\n",
      dry_run: true,
    });
    await write(root, "src/delete.txt", "changed\n");
    const staleDelete = await fileAction({
      roots: [root],
      action: "delete",
      path: "src/delete.txt",
      expected_sha256: deletePreview.pre_sha256,
    });
    expect(staleDelete).toMatchObject({ status: "error", error: { code: "stale_file" } });
    expect(await read(root, "src/delete.txt")).toBe("changed\n");

    const movePreview = await applyFileEdits({
      roots: [root],
      path: "src/move.txt",
      rewrite: "move me\n",
      dry_run: true,
    });
    await write(root, "src/move.txt", "changed move\n");
    const staleMove = await fileAction({
      roots: [root],
      action: "move",
      path: "src/move.txt",
      new_path: "src/moved.txt",
      expected_sha256: movePreview.pre_sha256,
    });
    expect(staleMove).toMatchObject({ status: "error", error: { code: "stale_file" } });
    expect(await read(root, "src/move.txt")).toBe("changed move\n");
    await expect(stat(join(root, "src/moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("post-edit cache integration helpers", () => {
  it("does not serve stale codemap structure after an edit", async () => {
    const root = await tempRoot("codemap-invalidate");
    await write(root, "src/a.ts", "export function before() { return 1; }\n");
    let catalog = await buildCatalog([root], defaultConfig);
    await warmCodemapCache(catalog, defaultConfig);
    expect(
      (await getCodeStructures(catalog, defaultConfig, { paths: ["src/a.ts"] })).files[0]?.text,
    ).toContain("before");

    const result = await applyFileEdits({
      roots: [root],
      path: "src/a.ts",
      search: "before",
      replace: "after",
      config: defaultConfig,
    });
    expect(result.status).toBe("applied");

    catalog = await buildCatalog([root], defaultConfig);
    const structure = await getCodeStructures(catalog, defaultConfig, { paths: ["src/a.ts"] });
    expect(structure.files[0]?.text).toContain("after");
    expect(structure.files[0]?.text).not.toContain("before");
  });
});

describe("reanchorIndentation divergent indents", () => {
  it("preserves relative nesting when file and search indents diverge (tabs vs spaces)", async () => {
    const root = await tempRoot("indent-divergent");
    await write(root, "src/d.py", "def outer():\n\tif flag:\n\t\told()\n");
    const summary = await applyFileEdits({
      roots: [root],
      path: "src/d.py",
      search: "  if flag:\n    old()",
      replace: "  if flag:\n    new_a()\n    if deep:\n      new_b()",
    });
    expect(summary.status).toBe("applied");
    expect(summary.matched_by).toEqual(["fuzzy"]);
    const content = await read(root, "src/d.py");
    expect(content).toBe("def outer():\n\tif flag:\n\t  new_a()\n\t  if deep:\n\t    new_b()\n");
    const depths = content
      .split("\n")
      .filter((line) => line.includes("new_"))
      .map((line) => (line.match(/^\s*/) ?? [""])[0].length);
    expect(depths[1]).toBeGreaterThan(depths[0] ?? 0);
  });
});
