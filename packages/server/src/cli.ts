#!/usr/bin/env node
import { loadConfig } from "@rp-mini/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRpMiniServer } from "./index.js";

async function main(argv: string[]): Promise<void> {
  const [command = "serve", ...rest] = argv;
  if (command === "serve") {
    const roots = parseRoots(rest);
    const rootDir = roots[0] ?? process.cwd();
    const config = await loadConfig(rootDir, { roots });
    const server = createRpMiniServer({ config });
    await server.connect(new StdioServerTransport());
    return;
  }

  if (command === "index") {
    console.log("not implemented");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--root") continue;
    const root = args[index + 1];
    if (!root) throw new Error("--root requires a path");
    roots.push(root);
    index += 1;
  }
  return roots.length > 0 ? roots : [process.cwd()];
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
