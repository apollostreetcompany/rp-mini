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

  it("returns not_implemented JSON text for valid stub calls", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: "file_search",
      arguments: { pattern: "Config", mode: "content", max_results: 5 },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: "not_implemented",
          tool: "file_search",
          parsed_args: {
            pattern: "Config",
            mode: "content",
            regex: false,
            context_lines: 0,
            max_results: 5,
          },
        }),
      },
    ]);
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
