import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createRpMiniServer } from "./index.js";

const execFileAsync = promisify(execFile);

async function connectedClient(options: Parameters<typeof createRpMiniServer>[0] = {}) {
  const server = createRpMiniServer(options);
  const client = new Client({ name: "rp-mini-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (
    !Array.isArray(content) ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  ) {
    throw new Error("Expected first MCP content item to be text.");
  }
  return content[0].text;
}

async function tempRoot(): Promise<string> {
  const path = join(tmpdir(), `rp-mini-server-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function initGitFixture(): Promise<string> {
  const root = await tempRoot();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await write(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
  await write(join(root, "src", "staged.ts"), "old\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

describe("rp-mini MCP server", () => {
  it("lists exactly the 10 default tools", async () => {
    const { client } = await connectedClient();
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "apply_edits",
        "file_actions",
        "file_search",
        "get_code_structure",
        "get_file_tree",
        "git",
        "manage_selection",
        "prompt",
        "read_file",
        "workspace_context",
      ].sort(),
    );
  });

  it("omits tools disabled in config", async () => {
    const { client } = await connectedClient({ config: { tools: { apply_edits: false } } });
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).not.toContain("apply_edits");
    expect(result.tools).toHaveLength(9);
  });

  it("serves real file_search over the linked transport", async () => {
    const root = await tempRoot();
    await write(
      join(root, "packages/core/src/tokens/index.ts"),
      "export function estimateTokens() {}\n",
    );
    const { client } = await connectedClient({ roots: [root] });

    const result = await client.callTool({
      name: "file_search",
      arguments: { pattern: "estimateTokens", mode: "content", max_results: 5 },
    });
    const payload = JSON.parse(firstText(result)) as {
      matches: Array<{ path: string }>;
      limit_hit: boolean;
    };

    expect(payload.limit_hit).toBe(false);
    expect(payload.matches.map((match) => match.path)).toEqual([
      "packages/core/src/tokens/index.ts",
    ]);
  });

  it("serves real read_file and get_file_tree over the linked transport", async () => {
    const root = await tempRoot();
    await write(join(root, "src", "file.ts"), "one\ntwo\nthree\nfour\nfive\n");
    const { client } = await connectedClient({ roots: [root] });

    const read = await client.callTool({
      name: "read_file",
      arguments: { path: "src/file.ts", start_line: -2 },
    });
    expect(JSON.parse(firstText(read))).toMatchObject({
      content: "four\nfive\n",
      totalLines: 5,
      firstLine: 4,
      lastLine: 5,
    });

    const tree = await client.callTool({ name: "get_file_tree", arguments: { mode: "auto" } });
    expect(JSON.parse(firstText(tree))).toMatchObject({ limit_hit: false });
    expect(firstText(tree)).toContain("src");
  });

  it("serves real get_code_structure with cap metadata over the linked transport", async () => {
    const root = await tempRoot();
    await write(
      join(root, "packages/core/src/catalog/index.ts"),
      [
        "export interface CatalogEntry { relativePath: string }",
        "export function getCatalog() { return null; }",
        "export function buildCatalog() { return null; }",
        "export function verifyFresh() { return true; }",
      ].join("\n"),
    );
    const { client } = await connectedClient({
      roots: [root],
      config: { caps: { structure_tokens: 80 } },
    });

    const result = await client.callTool({
      name: "get_code_structure",
      arguments: { paths: ["packages/core/src/catalog/index.ts"], max_results: 10 },
    });
    const payload = JSON.parse(firstText(result)) as {
      files: Array<{ path: string; text: string }>;
      limit_hit: boolean;
      omitted_total: number;
    };

    expect(payload.files[0]?.text).toContain("getCatalog");
    expect(payload.files[0]?.text).toContain("buildCatalog");
    expect(payload.files[0]?.text).toContain("verifyFresh");
    expect(payload.limit_hit).toBe(false);
  });

  it("returns the selected-scope placeholder until selection exists", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: "get_code_structure",
      arguments: { scope: "selected" },
    });

    expect(JSON.parse(firstText(result))).toEqual({
      error: { code: "not_available_until_selection" },
    });
  });

  it("serves manage_selection, prompt, workspace_context, selected tree, and selected structure", async () => {
    const root = await tempRoot();
    await write(
      join(root, "src", "consumer.ts"),
      "import type { User } from './model';\nexport function show(user: User): string { return user.name; }\n",
    );
    await write(join(root, "src", "model.ts"), "export interface User { name: string }\n");
    await write(join(root, "src", "notes.md"), "# Notes\n");
    const { client } = await connectedClient({
      roots: [root],
      sessionId: "server-selection",
      now: () => new Date("2026-06-10T00:00:00.000Z"),
    });

    const set = await client.callTool({
      name: "manage_selection",
      arguments: {
        op: "set",
        mode: "full",
        paths: ["src/consumer.ts", "src/notes.md"],
        view: "summary",
      },
    });
    expect(JSON.parse(firstText(set))).toMatchObject({
      summary: { files: 3, full: 2, codemaps: 1 },
    });

    const files = await client.callTool({
      name: "manage_selection",
      arguments: { op: "get", view: "files" },
    });
    const filesPayload = JSON.parse(firstText(files)) as {
      files: Array<{ path: string; mode: string; auto?: boolean }>;
    };
    expect(filesPayload.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/consumer.ts", mode: "full" }),
        expect.objectContaining({ path: "src/model.ts", mode: "codemap", auto: true }),
      ]),
    );

    await client.callTool({ name: "prompt", arguments: { op: "set", text: "handoff text" } });
    await client.callTool({
      name: "prompt",
      arguments: { op: "append", text: "\nmore" },
    });
    const prompt = await client.callTool({ name: "prompt", arguments: { op: "get" } });
    expect(JSON.parse(firstText(prompt))).toMatchObject({ text: "handoff text\nmore" });

    const tree = await client.callTool({
      name: "get_file_tree",
      arguments: { mode: "selected" },
    });
    expect(firstText(tree)).toContain("consumer.ts * +");
    expect(firstText(tree)).toContain("model.ts +");
    expect(firstText(tree)).not.toContain("unselected.ts");

    const structure = await client.callTool({
      name: "get_code_structure",
      arguments: { scope: "selected" },
    });
    expect(firstText(structure)).toContain("consumer.ts");
    expect(firstText(structure)).toContain("model.ts");

    const firstSnapshot = await client.callTool({
      name: "workspace_context",
      arguments: { op: "snapshot" },
    });
    const secondSnapshot = await client.callTool({
      name: "workspace_context",
      arguments: { op: "snapshot" },
    });
    const firstPayload = JSON.parse(firstText(firstSnapshot)) as {
      content_hash: string;
      sections: Record<string, string>;
      tokens: { total: number };
    };
    const secondPayload = JSON.parse(firstText(secondSnapshot)) as { content_hash: string };
    expect(firstPayload.content_hash).toBe(secondPayload.content_hash);
    expect(firstPayload.sections.user_instructions).toContain("handoff text");
    expect(firstPayload.tokens.total).toBeGreaterThan(0);

    await client.callTool({
      name: "manage_selection",
      arguments: {
        op: "add",
        mode: "slices",
        slices: [{ path: "src/model.ts", ranges: [{ start_line: 1, end_line: 1 }] }],
      },
    });
    const changedSnapshot = await client.callTool({
      name: "workspace_context",
      arguments: { op: "snapshot", include: ["selection", "tokens"] },
    });
    expect(JSON.parse(firstText(changedSnapshot)).content_hash).not.toBe(firstPayload.content_hash);

    const exported = await client.callTool({
      name: "workspace_context",
      arguments: { op: "export", include: ["prompt", "tokens"] },
    });
    const exportPayload = JSON.parse(firstText(exported)) as {
      payload_path: string;
      receipt_path: string;
      content_hash: string;
    };
    expect(exportPayload.payload_path).toMatch(/\.rp-mini\/exports\/2026-06-10T00-00-00-000Z-/);
    expect(exportPayload.receipt_path).toBe(exportPayload.payload_path.replace(/\.md$/, ".json"));
    expect(await readFile(exportPayload.payload_path, "utf8")).toContain("handoff text");
    expect(JSON.parse(await readFile(exportPayload.receipt_path, "utf8"))).toMatchObject({
      schema: "rp-mini-receipt@1",
      content_hash: exportPayload.content_hash,
    });
  });

  it("exports packaged context and receipt with preset and response_type", async () => {
    const root = await tempRoot();
    await write(join(root, "src", "entry.ts"), "export function entry() { return 1; }\n");
    await write(join(root, "src", "route.ts"), "export const route = '/mvp';\n");
    const { client } = await connectedClient({
      roots: [root],
      sessionId: "packager-export",
      now: () => new Date("2026-06-10T00:00:00.000Z"),
    });

    await client.callTool({
      name: "manage_selection",
      arguments: {
        op: "set",
        mode: "full",
        paths: ["src/route.ts", "src/entry.ts"],
      },
    });
    await client.callTool({
      name: "prompt",
      arguments: { op: "set", text: "Build the MVP route." },
    });

    const first = await client.callTool({
      name: "workspace_context",
      arguments: { op: "export", preset: "plan" },
    });
    const second = await client.callTool({
      name: "workspace_context",
      arguments: { op: "export", response_type: "plan" },
    });
    const firstPayload = JSON.parse(firstText(first)) as {
      payload_path: string;
      receipt_path: string;
      content_hash: string;
      total_tokens: number;
      preset: string;
    };
    const secondPayload = JSON.parse(firstText(second)) as {
      payload_path: string;
      content_hash: string;
    };

    expect(firstPayload.preset).toBe("plan");
    expect(firstPayload.total_tokens).toBeGreaterThan(0);
    expect(firstPayload.content_hash).toBe(secondPayload.content_hash);
    expect(firstPayload.payload_path).not.toBe(secondPayload.payload_path);
    const payloadText = await readFile(firstPayload.payload_path, "utf8");
    const receipt = JSON.parse(await readFile(firstPayload.receipt_path, "utf8")) as {
      files: Array<{ path: string; mode: string; tokens: number }>;
      preset: string;
      content_hash: string;
    };
    expect(payloadText).toContain("<file_map>");
    expect(payloadText).toContain("<file_contents>");
    expect(payloadText).toContain('<meta prompt 1 = "Architect">');
    expect(payloadText).toContain("<user_instructions>");
    expect(receipt).toMatchObject({
      preset: "plan",
      content_hash: firstPayload.content_hash,
    });
    expect(receipt.files.map((file) => file.path)).toEqual(["src/entry.ts", "src/route.ts"]);
    expect(receipt.files.every((file) => file.tokens > 0)).toBe(true);
  });

  it("drops stale slices after selected file content changes", async () => {
    const root = await tempRoot();
    await write(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
    const { client } = await connectedClient({
      roots: [root],
      sessionId: "slice-invalid",
      config: { selection: { auto_codemaps: false } },
    });

    await client.callTool({
      name: "manage_selection",
      arguments: {
        op: "set",
        mode: "slices",
        slices: [{ path: "src/a.ts", ranges: [{ start_line: 2, end_line: 2 }] }],
      },
    });
    await write(join(root, "src", "a.ts"), "one\nchanged\nthree\n");

    const result = await client.callTool({
      name: "workspace_context",
      arguments: { op: "snapshot", include: ["selection"] },
    });
    const payload = JSON.parse(firstText(result)) as { selection: { entries: unknown[] } };
    expect(payload.selection.entries[0]).toMatchObject({
      path: "src/a.ts",
      mode: "full",
      slices_invalidated: true,
    });
  });

  it("rejects bad file_search args through schema validation", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: "file_search",
      arguments: { pattern: "", max_results: 0 },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Input validation error");
  });

  it("rejects bad apply_edits args through schema validation", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: "apply_edits",
      arguments: { path: "src/file.ts", search: "a", replace: "b", rewrite: "c" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Input validation error");
  });

  it("serves real apply_edits over linked transport including fuzzy and ambiguity fail-closed", async () => {
    const root = await tempRoot();
    await write(
      join(root, "src", "a.ts"),
      [
        "export function calculateTotal(value: number) {",
        "  return value + 1;",
        "}",
        "function duplicate() { return 1; }",
        "function duplicate() { return 2; }",
        "",
      ].join("\n"),
    );
    const original = await readFile(join(root, "src", "a.ts"), "utf8");
    const { client } = await connectedClient({ roots: [root] });

    const fuzzy = await client.callTool({
      name: "apply_edits",
      arguments: {
        path: "src/a.ts",
        search: [
          "private function calculateTotel(value:   number) {",
          "return value + 1;",
          "}",
        ].join("\n"),
        replace: ["function calculateTotal(value: number) {", "  return value + 2;", "}"].join(
          "\n",
        ),
        verbose: true,
      },
    });
    const fuzzyPayload = JSON.parse(firstText(fuzzy)) as {
      status: string;
      matched_by: string[];
      unified_diff: string;
    };
    expect(fuzzyPayload.status).toBe("ok");
    expect(fuzzyPayload.matched_by).toEqual(["fuzzy"]);
    expect(fuzzyPayload.unified_diff).toContain("+  return value + 2;");

    const afterFuzzy = await readFile(join(root, "src", "a.ts"), "utf8");
    const ambiguous = await client.callTool({
      name: "apply_edits",
      arguments: {
        path: "src/a.ts",
        search: "private function duplicate() { return",
        replace: "function renamed() { return",
      },
    });
    const ambiguousPayload = JSON.parse(firstText(ambiguous)) as {
      status: string;
      error: { code: string; candidates: number[] };
    };
    expect(ambiguousPayload).toMatchObject({
      status: "error",
      error: { code: "ambiguous_match", candidates: [4, 5] },
    });
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(afterFuzzy);
    expect(afterFuzzy).not.toBe(original);
  });

  it("serves a transactional 3-edit batch with hand-computed final content", async () => {
    const root = await tempRoot();
    await write(join(root, "src", "batch.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const { client } = await connectedClient({ roots: [root] });

    const result = await client.callTool({
      name: "apply_edits",
      arguments: {
        path: "src/batch.txt",
        edits: [
          { search: "one", replace: "zero\none" },
          { search: "three\nfour", replace: "THREE" },
          { search: "five", replace: "FIVE" },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      edits_applied: number;
      matched_by: string[];
    };

    expect(payload).toMatchObject({
      status: "ok",
      edits_applied: 3,
      matched_by: ["literal", "literal", "literal"],
    });
    expect(await readFile(join(root, "src", "batch.txt"), "utf8")).toBe(
      "zero\none\ntwo\nTHREE\nFIVE\n",
    );
  });

  it("updates selection tokens, invalidates stale slices, refreshes codemaps, and handles file_actions", async () => {
    const root = await tempRoot();
    await write(join(root, "src", "a.ts"), "export function before() { return 1; }\n");
    await write(join(root, "src", "slice.ts"), "one\ntwo\nthree\n");
    const { client } = await connectedClient({
      roots: [root],
      sessionId: "edit-integration",
      config: { selection: { auto_codemaps: false } },
    });

    await client.callTool({
      name: "manage_selection",
      arguments: { op: "set", mode: "full", paths: ["src/a.ts"], view: "files" },
    });
    const before = JSON.parse(
      firstText(
        await client.callTool({
          name: "manage_selection",
          arguments: { op: "get", view: "files" },
        }),
      ),
    ) as { files: Array<{ path: string; tokens: { full: number } }> };

    await client.callTool({
      name: "apply_edits",
      arguments: {
        path: "src/a.ts",
        search: "before",
        replace: "afterAndLongerNameWithEnoughExtraCharactersToChangeTokenCount",
      },
    });
    const after = JSON.parse(
      firstText(
        await client.callTool({
          name: "manage_selection",
          arguments: { op: "get", view: "files" },
        }),
      ),
    ) as { files: Array<{ path: string; tokens: { full: number } }> };
    expect(after.files[0]!.tokens.full).toBeGreaterThan(before.files[0]!.tokens.full);

    const structure = JSON.parse(
      firstText(
        await client.callTool({
          name: "get_code_structure",
          arguments: { paths: ["src/a.ts"] },
        }),
      ),
    ) as { files: Array<{ text: string }> };
    expect(structure.files[0]!.text).toContain("afterAndLongerName");
    expect(structure.files[0]!.text).not.toContain("before");

    await client.callTool({
      name: "manage_selection",
      arguments: {
        op: "set",
        mode: "slices",
        slices: [{ path: "src/slice.ts", ranges: [{ start_line: 2, end_line: 2 }] }],
      },
    });
    await client.callTool({
      name: "apply_edits",
      arguments: { path: "src/slice.ts", search: "two", replace: "changed" },
    });
    const sliced = JSON.parse(
      firstText(
        await client.callTool({
          name: "manage_selection",
          arguments: { op: "get", view: "files" },
        }),
      ),
    ) as { files: Array<{ path: string; mode: string; slices_invalidated?: boolean }> };
    expect(sliced.files.find((file) => file.path === "src/slice.ts")).toMatchObject({
      mode: "full",
      slices_invalidated: true,
    });

    const created = JSON.parse(
      firstText(
        await client.callTool({
          name: "file_actions",
          arguments: { action: "create", path: "src/new.txt", content: "new\n" },
        }),
      ),
    );
    expect(created).toMatchObject({ status: "ok", file_created: true });
    const outside = JSON.parse(
      firstText(
        await client.callTool({
          name: "file_actions",
          arguments: { action: "create", path: "../outside.txt", content: "x" },
        }),
      ),
    );
    expect(outside).toMatchObject({ status: "error", error: { code: "outside_workspace" } });
    await client.callTool({
      name: "manage_selection",
      arguments: { op: "set", mode: "full", paths: ["src/new.txt"] },
    });
    await client.callTool({
      name: "file_actions",
      arguments: { action: "delete", path: "src/new.txt" },
    });
    const files = JSON.parse(
      firstText(
        await client.callTool({
          name: "manage_selection",
          arguments: { op: "get", view: "files" },
        }),
      ),
    ) as { files: Array<{ path: string }> };
    expect(files.files.map((file) => file.path)).not.toContain("src/new.txt");
  });

  it("serves read-only git status and structured diff over linked transport", async () => {
    const root = await initGitFixture();
    await write(join(root, "src", "a.ts"), "one\nTWO\nthree\nfour\n");
    await write(join(root, "src", "staged.ts"), "new\n");
    await git(root, ["add", "src/staged.ts"]);
    await write(join(root, "src", "new.ts"), "new\n");
    const { client } = await connectedClient({ roots: [root] });

    const status = JSON.parse(
      firstText(await client.callTool({ name: "git", arguments: { op: "status" } })),
    ) as { files: Array<{ path: string; state: string }>; totals: Record<string, number> };
    expect(status.files).toEqual(
      expect.arrayContaining([
        { path: "src/a.ts", state: "unstaged" },
        { path: "src/staged.ts", state: "staged" },
        { path: "src/new.ts", state: "untracked" },
      ]),
    );
    expect(status.totals).toMatchObject({ staged: 1, unstaged: 1, untracked: 1 });

    const diff = JSON.parse(
      firstText(
        await client.callTool({
          name: "git",
          arguments: { op: "diff", detail: "patches", compare: "uncommitted" },
        }),
      ),
    ) as { files: Array<{ path: string; hunks: Array<{ oldStart: number; newStart: number }> }> };
    expect(diff.files.find((file) => file.path === "src/a.ts")).toMatchObject({
      hunks: [{ oldStart: 1, newStart: 1 }],
    });
  });

  it("exports review preset with automatic git diff section and token accounting", async () => {
    const root = await initGitFixture();
    await write(join(root, "src", "a.ts"), "one\nTWO\nthree\nfour\n");
    const { client } = await connectedClient({
      roots: [root],
      sessionId: "git-export",
      now: () => new Date("2026-06-10T00:00:00.000Z"),
    });

    await client.callTool({
      name: "manage_selection",
      arguments: { op: "set", mode: "full", paths: ["src/a.ts"] },
    });
    await client.callTool({
      name: "prompt",
      arguments: { op: "set", text: "Review the diff." },
    });

    const result = await client.callTool({
      name: "workspace_context",
      arguments: { op: "export", preset: "review" },
    });
    const payload = JSON.parse(firstText(result)) as {
      payload_path: string;
      sections: Record<string, string>;
      tokens: { git_diff: number };
    };
    const text = await readFile(payload.payload_path, "utf8");

    expect(payload.sections.git_diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(payload.sections.git_diff).toContain("+four");
    expect(payload.tokens.git_diff).toBeGreaterThan(0);
    expect(text).toContain("<git_diff>");
    expect(text).toContain("diff --git a/src/a.ts b/src/a.ts");
  });
});
