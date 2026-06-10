import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createRpMiniServer } from "./index.js";

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
    expect(firstPayload.sections.prompt).toContain("handoff text");
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
    const exportPayload = JSON.parse(firstText(exported)) as { path: string };
    expect(exportPayload.path).toMatch(/\.rp-mini\/exports\/2026-06-10T00-00-00-000Z-/);
    expect(await readFile(exportPayload.path, "utf8")).toContain("handoff text");
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
});
