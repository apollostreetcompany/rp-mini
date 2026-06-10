import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createRpMiniServer, runRpMiniTool } from "./index.js";

async function connectedClient(options: Parameters<typeof createRpMiniServer>[0] = {}) {
  const server = createRpMiniServer(options);
  const client = new Client({ name: "rp-mini-dynamic-root-test", version: "0.0.0" });
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
  const path = join(tmpdir(), `rp-mini-dynamic-root-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

describe("dynamic MCP roots", () => {
  it("targets file_search, read_file, and get_file_tree to an explicit root without changing default root", async () => {
    const tempA = await tempRoot();
    const tempB = await tempRoot();
    await write(join(tempA, "src", "only-a.ts"), "export const marker = 'from-a';\n");
    await write(join(tempB, "src", "only-b.ts"), "export const marker = 'from-b';\n");
    const { client } = await connectedClient({ roots: [tempA] });

    const primarySearch = await client.callTool({
      name: "file_search",
      arguments: { pattern: "marker", mode: "content", max_results: 5 },
    });
    const dynamicSearch = await client.callTool({
      name: "file_search",
      arguments: { root: tempB, pattern: "marker", mode: "content", max_results: 5 },
    });

    expect(
      JSON.parse(firstText(primarySearch)).matches.map((match: { path: string }) => match.path),
    ).toEqual(["src/only-a.ts"]);
    expect(
      JSON.parse(firstText(dynamicSearch)).matches.map((match: { path: string }) => match.path),
    ).toEqual(["src/only-b.ts"]);

    const read = await client.callTool({
      name: "read_file",
      arguments: { root: tempB, path: "src/only-b.ts" },
    });
    expect(JSON.parse(firstText(read))).toMatchObject({
      content: "export const marker = 'from-b';\n",
    });

    const tree = await client.callTool({
      name: "get_file_tree",
      arguments: { root: tempB, mode: "auto" },
    });
    expect(firstText(tree)).toContain("only-b.ts");
    expect(firstText(tree)).not.toContain("only-a.ts");
  });

  it("keeps dynamic-root selections isolated and reloads them after LRU eviction", async () => {
    const tempA = await tempRoot();
    const tempB = await tempRoot();
    const tempC = await tempRoot();
    await write(join(tempA, "src", "a.ts"), "export const a = 1;\n");
    await write(join(tempB, "src", "b.ts"), "export const b = 2;\n");
    await write(join(tempC, "src", "c.ts"), "export const c = 3;\n");
    const { client } = await connectedClient({
      roots: [tempA],
      sessionId: "dynamic-selection",
      config: { dynamic_roots: { max: 1 }, selection: { auto_codemaps: false } },
    });

    await client.callTool({
      name: "manage_selection",
      arguments: { root: tempB, op: "add", mode: "full", paths: ["src/b.ts"] },
    });
    const dynamicContext = await client.callTool({
      name: "workspace_context",
      arguments: { root: tempB, op: "snapshot", include: ["selection", "tokens"] },
    });
    expect(JSON.parse(firstText(dynamicContext))).toMatchObject({
      selection: { entries: [{ path: "src/b.ts", mode: "full" }] },
    });

    const primaryContext = await client.callTool({
      name: "workspace_context",
      arguments: { op: "snapshot", include: ["selection", "tokens"] },
    });
    expect(JSON.parse(firstText(primaryContext)).selection.entries).toEqual([]);

    await client.callTool({
      name: "manage_selection",
      arguments: { root: tempC, op: "add", mode: "full", paths: ["src/c.ts"] },
    });
    const reloadedDynamicContext = await client.callTool({
      name: "workspace_context",
      arguments: { root: tempB, op: "snapshot", include: ["selection", "tokens"] },
    });
    expect(JSON.parse(firstText(reloadedDynamicContext))).toMatchObject({
      selection: { entries: [{ path: "src/b.ts", mode: "full" }] },
    });
    expect(
      await readFile(join(tempB, ".rp-mini", "sessions", "dynamic-selection.json"), "utf8"),
    ).toContain("src/b.ts");
  });

  it("returns structured errors for invalid or disabled dynamic roots", async () => {
    const tempA = await tempRoot();
    const missing = join(tempA, "missing");
    await write(join(tempA, "not-a-dir.txt"), "file\n");
    const { client } = await connectedClient({ roots: [tempA] });

    for (const [root, code] of [
      ["relative-root", "root_not_absolute"],
      [missing, "root_not_found"],
      [join(tempA, "not-a-dir.txt"), "root_not_directory"],
    ] as const) {
      const result = await client.callTool({
        name: "read_file",
        arguments: { root, path: "anything.ts" },
      });
      expect(JSON.parse(firstText(result))).toMatchObject({ error: { code } });
    }

    const disabled = await runRpMiniTool(
      "file_search",
      { root: await tempRoot(), pattern: "anything" },
      { roots: [tempA], config: { dynamic_roots: { enabled: false } } },
    );
    expect(disabled).toMatchObject({ error: { code: "dynamic_roots_disabled" } });
  });
});
