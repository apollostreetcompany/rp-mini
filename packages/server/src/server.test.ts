import { mkdir, writeFile } from "node:fs/promises";
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
