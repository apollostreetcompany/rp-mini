import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd());
const serverCli = join(repoRoot, "packages/server/dist/cli.js");

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

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = JSON.parse(firstText(await client.callTool({ name, arguments: args }))) as Record<
    string,
    unknown
  >;
  expect(payload.error, `${name} returned an error payload`).toBeUndefined();
  return payload;
}

async function withStdioClient<T>(sessionName: string, run: (client: Client) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), `rp-mini-stress-home-${sessionName}-`));
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverCli, "serve", "--root", repoRoot],
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      RP_MINI_SELECTION_PERSIST: "true",
    },
  });
  const client = new Client({ name: `rp-mini-stress-${sessionName}`, version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

async function runSession(sessionName: string): Promise<void> {
  await withStdioClient(sessionName, async (client) => {
    await client.listTools();
    const searches = [
      { pattern: "SelectionState", mode: "content" },
      { pattern: "buildCatalog", mode: "content" },
      { pattern: "workspace_context", mode: "content" },
      { pattern: "codemap", mode: "content" },
      { pattern: "manage_selection", mode: "both" },
    ];
    for (const search of searches) {
      const result = await callJson(client, "file_search", { ...search, max_results: 10 });
      expect(Array.isArray(result.matches)).toBe(true);
    }

    for (const path of ["README.md", "AGENTS.md", "packages/server/src/index.ts"]) {
      const result = await callJson(client, "read_file", { path, limit: 20 });
      expect(result.content).toEqual(expect.any(String));
    }

    for (const path of ["packages/core/src/config/index.ts", "packages/server/src/index.ts"]) {
      const result = await callJson(client, "get_code_structure", { paths: [path] });
      expect(Array.isArray(result.files)).toBe(true);
    }

    const tree = await callJson(client, "get_file_tree", { mode: "auto", max_depth: 3 });
    expect(tree.tree).toEqual(expect.any(String));

    const selection = await callJson(client, "manage_selection", {
      op: "set",
      mode: "full",
      paths: ["README.md", "AGENTS.md", "packages/server/src/index.ts"],
      view: "summary",
    });
    expect(selection.summary).toEqual(expect.any(Object));

    const context = await callJson(client, "workspace_context", {
      op: "snapshot",
      include: ["selection", "files", "tree", "tokens"],
    });
    expect(context.content_hash).toEqual(expect.any(String));
  });
}

async function parseCodemapCacheJson(): Promise<void> {
  const dir = join(repoRoot, ".rp-mini", "codemap-cache");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const text = await readFile(join(dir, file), "utf8");
    expect(() => JSON.parse(text), `${file} should be valid JSON`).not.toThrow();
  }
}

describe("rp-mini stdio multi-agent stress", () => {
  it("runs 4 concurrent real stdio sessions without serialized blocking or torn codemap cache writes", async () => {
    const singleStart = performance.now();
    await runSession("baseline");
    const singleMs = performance.now() - singleStart;

    const concurrentStart = performance.now();
    await Promise.all([0, 1, 2, 3].map((index) => runSession(`concurrent-${index}`)));
    const concurrentMs = performance.now() - concurrentStart;

    expect(concurrentMs).toBeLessThan(singleMs * 2.5);
    await parseCodemapCacheJson();
  }, 120_000);
});
