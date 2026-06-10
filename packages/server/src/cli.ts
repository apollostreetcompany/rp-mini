#!/usr/bin/env node
import {
  atomicWriteJson,
  buildCatalog,
  cacheDir,
  estimateTokens,
  loadConfig,
  warmCodemapCache,
  type DeepPartial,
  type Config,
} from "@rp-mini/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRpMiniServer, runRpMiniTool, toolDefinitions } from "./index.js";

const HELP = `Usage:
  rp-mini --help | help
  rp-mini serve [--root <path>]...
  rp-mini index [root...]

Shell wrappers:
  rp-mini search <root> <pattern> [--mode auto|path|content|both] [--regex] [--whole-word] [--context-lines N] [--max-results N] [--paths a,b] [--extensions .ts,.tsx] [--exclude pattern]
  rp-mini read <root> <path> [--start-line N] [--limit N] [--json]
  rp-mini tree <root> [--mode auto|full|folders|selected] [--max-depth N] [--path path] [--json]
  rp-mini structure <root> <path...> [--max-results N] [--json]
  rp-mini select <root> <get|add|remove|set|clear|promote|demote|save_profile|load_profile|list_profiles> [path...] [--mode full|slices|codemap_only] [--view summary|files|content|codemaps] [--name name] [--session id] [--json]
  rp-mini context <root> [snapshot|export] [--include prompt,selection,code,files,tree,tokens,git_diff] [--preset name] [--response-type type] [--git-compare spec] [--session id] [--json]
  rp-mini prompt <root> <get|set|append|clear> [text] [--session id] [--json]
  rp-mini git <root> <status|diff|log|show|blame> [--compare spec] [--detail summary|files|patches|full] [--path path] [--count N] [--start-line N] [--end-line N] [--revspec rev]
  rp-mini edit <root> <path> (--rewrite text | --search text --replace text) [--all] [--on-missing error|create] [--verbose] [--json]
  rp-mini file-action <root> <create|delete|move> <path> [--content text] [--new-path path] [--if-exists error|overwrite] [--json]
  rp-mini tokens <text...> | rp-mini tokens --file <path>
  rp-mini tool <root> <tool-name> --json-args '{"key":"value"}' [--session id]

MCP tools available through "tool":
  ${toolDefinitions.map((tool) => tool.name).join(", ")}
`;

type FlagValue = string | true;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue[]>;
}

async function main(argv: string[]): Promise<void> {
  const [command = "serve", ...rest] = argv;
  if (["--help", "-h", "help"].includes(command)) {
    console.log(HELP);
    return;
  }

  if (command === "serve") return serve(rest);
  if (command === "index") return index(rest);
  if (command === "search") return search(rest);
  if (command === "read") return read(rest);
  if (command === "tree") return tree(rest);
  if (command === "structure") return structure(rest);
  if (command === "select") return select(rest);
  if (command === "context") return context(rest);
  if (command === "prompt") return prompt(rest);
  if (command === "git") return git(rest);
  if (command === "edit") return edit(rest);
  if (command === "file-action") return fileAction(rest);
  if (command === "tokens") return tokens(rest);
  if (command === "tool") return tool(rest);

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

async function serve(args: string[]): Promise<void> {
  const roots = parseRoots(args);
  const rootDir = roots[0] ?? process.cwd();
  const config = await loadConfig(rootDir, { roots });
  const server = createRpMiniServer({ config });
  await server.connect(new StdioServerTransport());
}

async function index(args: string[]): Promise<void> {
  const roots = args.length > 0 ? args.map((root) => resolve(root)) : [process.cwd()];
  for (const root of roots) {
    const config = await loadConfig(root, { roots: [root] });
    const catalog = await buildCatalog([root], config);
    const rootCatalog = catalog.roots[0]!;
    const codemaps = await warmCodemapCache(catalog, config);
    await atomicWriteJson(join(cacheDir(root), "catalog.json"), catalog);
    console.log(
      `${root}: ${rootCatalog.files.length} files, ${rootCatalog.dirs.length} dirs, ${rootCatalog.ignored} ignored, took ${(rootCatalog.tookMs / 1000).toFixed(3)}s; codemaps: ${codemaps.cached} cached, ${codemaps.computed} computed, ${codemaps.skipped} skipped(gated)`,
    );
  }
}

async function search(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json", "regex", "whole-word"]));
  const [root, pattern] = parsed.positionals;
  if (!root || !pattern) throw new Error("search requires <root> and <pattern>.");
  const result = await runLoadedTool(root, "file_search", {
    pattern,
    mode: flagString(parsed, "mode"),
    regex: flagBoolean(parsed, "regex"),
    whole_word: flagBoolean(parsed, "whole-word"),
    context_lines: flagNumber(parsed, "context-lines"),
    max_results: flagNumber(parsed, "max-results"),
    filters: compactObject({
      paths: flagCsv(parsed, "paths"),
      extensions: flagCsv(parsed, "extensions"),
      exclude: flagCsv(parsed, "exclude"),
    }),
    contextPaths: flagCsv(parsed, "context-paths"),
  });
  if (flagBoolean(parsed, "json")) {
    printJson(result);
  } else {
    printSearch(result);
  }
}

async function read(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root, path] = parsed.positionals;
  if (!root || !path) throw new Error("read requires <root> and <path>.");
  const result = await runLoadedTool(root, "read_file", {
    path,
    start_line: flagNumber(parsed, "start-line"),
    limit: flagNumber(parsed, "limit"),
  });
  if (flagBoolean(parsed, "json")) {
    printJson(result);
    return;
  }
  assertNoToolError(result);
  process.stdout.write(String((result as { content: string }).content));
}

async function tree(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root] = parsed.positionals;
  if (!root) throw new Error("tree requires <root>.");
  const result = await runLoadedTool(root, "get_file_tree", {
    mode: flagString(parsed, "mode"),
    max_depth: flagNumber(parsed, "max-depth"),
    path: flagString(parsed, "path"),
  });
  if (flagBoolean(parsed, "json")) {
    printJson(result);
    return;
  }
  assertNoToolError(result);
  process.stdout.write(String((result as { tree: string }).tree));
}

async function structure(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root, ...paths] = parsed.positionals;
  if (!root || paths.length === 0) throw new Error("structure requires <root> and <path...>.");
  const result = await runLoadedTool(root, "get_code_structure", {
    paths,
    max_results: flagNumber(parsed, "max-results"),
  });
  if (flagBoolean(parsed, "json")) {
    printJson(result);
    return;
  }
  assertNoToolError(result);
  for (const file of (result as { files: Array<{ path: string; text: string }> }).files) {
    console.log(`## ${file.path}`);
    console.log(file.text);
  }
}

async function select(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json", "strict"]));
  const [root, op, ...paths] = parsed.positionals;
  if (!root || !op) throw new Error("select requires <root> and <op>.");
  const result = await runLoadedTool(
    root,
    "manage_selection",
    {
      op,
      mode: flagString(parsed, "mode"),
      paths,
      view: flagString(parsed, "view"),
      name: flagString(parsed, "name"),
      strict: flagBoolean(parsed, "strict"),
    },
    flagString(parsed, "session"),
  );
  printJson(result);
}

async function context(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root, op = "snapshot"] = parsed.positionals;
  if (!root) throw new Error("context requires <root>.");
  const result = await runLoadedTool(
    root,
    "workspace_context",
    {
      op,
      include: flagCsv(parsed, "include"),
      preset: flagString(parsed, "preset"),
      response_type: flagString(parsed, "response-type"),
      git_compare: flagString(parsed, "git-compare"),
    },
    flagString(parsed, "session"),
  );
  printJson(result);
}

async function prompt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root, op, ...textParts] = parsed.positionals;
  if (!root || !op) throw new Error("prompt requires <root> and <op>.");
  const result = await runLoadedTool(
    root,
    "prompt",
    { op, text: textParts.join(" ") || flagString(parsed, "text") },
    flagString(parsed, "session"),
  );
  if (flagBoolean(parsed, "json")) {
    printJson(result);
  } else {
    process.stdout.write(String(result));
    if (!String(result).endsWith("\n")) process.stdout.write("\n");
  }
}

async function git(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root, op] = parsed.positionals;
  if (!root || !op) throw new Error("git requires <root> and <op>.");
  const result = await runLoadedTool(root, "git", {
    op,
    compare: flagString(parsed, "compare"),
    detail: flagString(parsed, "detail"),
    path: flagString(parsed, "path"),
    count: flagNumber(parsed, "count"),
    start_line: flagNumber(parsed, "start-line"),
    end_line: flagNumber(parsed, "end-line"),
    revspec: flagString(parsed, "revspec"),
  });
  printJson(result);
}

async function edit(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json", "all", "verbose"]));
  const [root, path] = parsed.positionals;
  if (!root || !path) throw new Error("edit requires <root> and <path>.");
  const result = await runLoadedTool(root, "apply_edits", {
    path,
    search: flagString(parsed, "search"),
    replace: flagString(parsed, "replace"),
    rewrite: flagString(parsed, "rewrite"),
    all: flagBoolean(parsed, "all"),
    on_missing: flagString(parsed, "on-missing"),
    verbose: flagBoolean(parsed, "verbose"),
  });
  printJson(result);
}

async function fileAction(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, new Set(["json"]));
  const [root, action, path] = parsed.positionals;
  if (!root || !action || !path) throw new Error("file-action requires <root> <action> <path>.");
  const result = await runLoadedTool(root, "file_actions", {
    action,
    path,
    content: flagString(parsed, "content"),
    new_path: flagString(parsed, "new-path"),
    if_exists: flagString(parsed, "if-exists"),
  });
  printJson(result);
}

async function tokens(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const file = flagString(parsed, "file");
  const text = file ? await readFile(file, "utf8") : parsed.positionals.join(" ");
  console.log(String(estimateTokens(text)));
}

async function tool(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [root, toolName] = parsed.positionals;
  if (!root || !toolName) throw new Error("tool requires <root> and <tool-name>.");
  const rawJson = flagString(parsed, "json-args") ?? "{}";
  const result = await runLoadedTool(
    root,
    toolName,
    JSON.parse(rawJson),
    flagString(parsed, "session"),
  );
  printJson(result);
}

async function runLoadedTool(
  root: string,
  toolName: string,
  args: unknown,
  sessionId?: string,
): Promise<unknown> {
  const absoluteRoot = resolve(root);
  const config = await loadConfig(absoluteRoot, { roots: [absoluteRoot] });
  return runRpMiniTool(toolName, compactDeep(args), {
    config: config as DeepPartial<Config>,
    roots: [absoluteRoot],
    sessionId,
  });
}

function parseRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--root") continue;
    const root = args[index + 1];
    if (!root) throw new Error("--root requires a path");
    roots.push(resolve(root));
    index += 1;
  }
  return roots.length > 0 ? roots : [process.cwd()];
}

function parseCliArgs(args: string[], booleanFlags = new Set<string>()): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, FlagValue[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey!;
    if (booleanFlags.has(key)) {
      addFlag(flags, key, inlineValue ?? true);
      continue;
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    addFlag(flags, key, value);
    if (inlineValue === undefined) index += 1;
  }
  return { positionals, flags };
}

function addFlag(flags: Map<string, FlagValue[]>, key: string, value: FlagValue): void {
  const values = flags.get(key) ?? [];
  values.push(value);
  flags.set(key, values);
}

function flagString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags.get(key)?.at(-1);
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(parsed: ParsedArgs, key: string): boolean | undefined {
  const value = parsed.flags.get(key)?.at(-1);
  if (value === undefined) return undefined;
  if (value === true) return true;
  return value === "true";
}

function flagNumber(parsed: ParsedArgs, key: string): number | undefined {
  const raw = flagString(parsed, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
  return value;
}

function flagCsv(parsed: ParsedArgs, key: string): string[] | undefined {
  const values = parsed.flags.get(key);
  if (!values?.length) return undefined;
  const items = values.flatMap((value) =>
    String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return items.length > 0 ? items : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

function compactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactDeep(item)]),
  );
}

function assertNoToolError(result: unknown): void {
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    (result as { error?: unknown }).error
  ) {
    throw new Error(JSON.stringify((result as { error: unknown }).error));
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printSearch(result: unknown): void {
  assertNoToolError(result);
  const search = result as {
    matches: Array<{
      path: string;
      line?: number;
      column?: number;
      matchText?: string;
      kind?: string;
    }>;
    limit_hit?: boolean;
    omitted_total?: number;
    suggestion?: string;
  };
  for (const match of search.matches) {
    const location =
      match.line === undefined ? match.path : `${match.path}:${match.line}:${match.column ?? 1}`;
    const text = match.matchText?.replace(/\s+/g, " ").trim();
    console.log(text ? `${location}: ${text}` : location);
  }
  if (search.limit_hit) {
    console.error(
      `limit_hit: omitted ${search.omitted_total ?? 0}. ${search.suggestion ?? ""}`.trim(),
    );
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
