import {
  defaultConfig,
  generateFileTree,
  getCodeStructures,
  getCatalog,
  readFileSlice,
  relativeToRoot,
  resolveRootPath,
  searchFiles,
  type CatalogFile,
  type Config,
  type DeepPartial,
  type FileCatalog,
} from "@rp-mini/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface RpMiniServerOptions {
  config?: DeepPartial<Config>;
  roots?: string[];
}

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  enabled?: (config: Config) => boolean;
};

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const toolDefinitions: ToolDefinition[] = [
  {
    name: "file_search",
    description:
      "Search files by path, content, or both. Defaults to mode=auto, max_results=50, response caps with limit_hit semantics.",
    inputSchema: z
      .object({
        pattern: z.string().min(1),
        mode: z.enum(["auto", "path", "content", "both"]).default("auto"),
        regex: z.boolean().default(false),
        whole_word: z.boolean().default(false),
        filters: z
          .object({
            paths: z.array(z.string()).optional(),
            extensions: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .optional(),
        contextPaths: z.array(z.string()).optional(),
        context_lines: nonNegativeInt.default(0),
        max_results: positiveInt.default(50),
      })
      .strict(),
  },
  {
    name: "read_file",
    description:
      "Read one file by path with optional start_line, negative tail offsets, and line limit; returns range metadata.",
    inputSchema: z
      .object({
        path: z.string().min(1),
        start_line: z.number().int().optional(),
        limit: positiveInt.optional(),
      })
      .strict(),
  },
  {
    name: "get_file_tree",
    description:
      "Render workspace tree in auto/full/folders/selected mode, with max_depth and auto-trim target caps.",
    inputSchema: z
      .object({
        mode: z.enum(["auto", "full", "folders", "selected"]).default("auto"),
        max_depth: nonNegativeInt.optional(),
        path: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    name: "get_code_structure",
    description:
      "Return codemap text for explicit paths or selected scope, max_results default 10 and structure token cap.",
    inputSchema: z
      .object({
        paths: z.array(z.string().min(1)).optional(),
        scope: z.enum(["selected"]).optional(),
        max_results: positiveInt.default(10),
      })
      .strict()
      .refine((args) => args.paths !== undefined || args.scope === "selected", {
        message: "Either paths or scope=selected is required.",
      }),
  },
  {
    name: "manage_selection",
    description:
      "Manage context selection: get/add/remove/set/clear/promote/demote with full, slices, or codemap_only modes.",
    inputSchema: z
      .object({
        op: z.enum(["get", "add", "remove", "set", "clear", "promote", "demote"]),
        mode: z.enum(["full", "slices", "codemap_only"]).optional(),
        paths: z.array(z.string().min(1)).optional(),
        slices: z
          .array(
            z
              .object({
                path: z.string().min(1),
                ranges: z
                  .array(
                    z.object({
                      start_line: positiveInt,
                      end_line: positiveInt.optional(),
                      description: z.string().optional(),
                    }),
                  )
                  .optional(),
                description: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        view: z.enum(["summary", "files", "content", "codemaps"]).default("summary"),
      })
      .strict(),
  },
  {
    name: "workspace_context",
    description:
      "Snapshot or export prompt, selection, code, files, tree, and token breakdown for budget checks.",
    inputSchema: z
      .object({
        op: z.enum(["snapshot", "export"]).default("snapshot"),
        include: z
          .array(z.enum(["prompt", "selection", "code", "files", "tree", "tokens"]))
          .optional(),
        preset: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    name: "prompt",
    description:
      "Get, set, append, or clear curated handoff instructions stored with the selection.",
    inputSchema: z
      .object({
        op: z.enum(["get", "set", "append", "clear"]),
        text: z.string().optional(),
      })
      .strict()
      .refine((args) => !["set", "append"].includes(args.op) || args.text !== undefined, {
        message: "text is required for set and append.",
      }),
  },
  {
    name: "apply_edits",
    description:
      "Apply rewrite, single search/replace, or edits[] using the later edit ladder; disabled by config when false.",
    enabled: (config) => config.tools.apply_edits,
    inputSchema: z
      .object({
        path: z.string().min(1),
        search: z.string().optional(),
        replace: z.string().optional(),
        edits: z
          .array(
            z
              .object({
                search: z.string().min(1),
                replace: z.string(),
              })
              .strict(),
          )
          .optional(),
        rewrite: z.string().optional(),
      })
      .strict()
      .refine(
        (args) => {
          const modes = [
            args.search !== undefined || args.replace !== undefined,
            args.edits !== undefined,
            args.rewrite !== undefined,
          ].filter(Boolean).length;
          return modes === 1 && (args.search === undefined) === (args.replace === undefined);
        },
        {
          message:
            "Provide exactly one of rewrite, edits[], or search+replace. search and replace must be paired.",
        },
      ),
  },
  {
    name: "file_actions",
    description:
      "Create, delete, or move files with if_exists guard; disabled by config when false.",
    enabled: (config) => config.tools.file_actions,
    inputSchema: z
      .object({
        op: z.enum(["create", "delete", "move"]),
        path: z.string().min(1),
        content: z.string().optional(),
        destination: z.string().min(1).optional(),
        if_exists: z.enum(["error", "overwrite", "skip"]).default("error"),
      })
      .strict(),
  },
  {
    name: "git",
    description:
      "Read-only git status/diff/log/show/blame with compare specs, detail levels, structured hunks, and safe flags.",
    enabled: (config) => config.tools.git,
    inputSchema: z
      .object({
        op: z.enum(["status", "diff", "log", "show", "blame"]),
        compare: z.string().optional(),
        detail: z.enum(["summary", "files", "patches", "full"]).default("summary"),
        path: z.string().min(1).optional(),
        count: positiveInt.optional(),
      })
      .strict(),
  },
];

export function createRpMiniServer(options: RpMiniServerOptions = {}): McpServer {
  const config = mergeConfig(defaultConfig, options.config ?? {}, options.roots);
  const server = new McpServer({ name: "rp-mini", version: "0.0.0" });

  for (const definition of toolDefinitions) {
    if (definition.enabled && !definition.enabled(config)) continue;
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (args) => toolResponse(await handleTool(definition.name, args, config)),
    );
  }

  return server;
}

async function handleTool(name: string, args: unknown, config: Config): Promise<unknown> {
  switch (name) {
    case "file_search": {
      const catalog = await getCatalog(config.roots, config);
      return searchFiles(catalog, config, normalizeSearchArgs(args));
    }
    case "read_file": {
      const catalog = await getCatalog(config.roots, config);
      const readArgs = args as { path: string; start_line?: number; limit?: number };
      const file = findCatalogFile(catalog, readArgs.path);
      if (!file) {
        return { error: { code: "not_found", message: `${readArgs.path} is not in the catalog.` } };
      }
      return readFileSlice(file, { startLine: readArgs.start_line, limit: readArgs.limit });
    }
    case "get_file_tree": {
      const catalog = await getCatalog(config.roots, config);
      const treeArgs = args as {
        mode?: "auto" | "full" | "folders" | "selected";
        max_depth?: number;
        path?: string;
      };
      return generateFileTree(catalog, config, {
        mode: treeArgs.mode,
        maxDepth: treeArgs.max_depth,
        path: treeArgs.path,
      });
    }
    case "get_code_structure": {
      const structureArgs = args as {
        paths?: string[];
        scope?: "selected";
        max_results?: number;
      };
      if (structureArgs.scope === "selected") {
        return { error: { code: "not_available_until_selection" } };
      }
      const catalog = await getCatalog(config.roots, config);
      return getCodeStructures(catalog, config, {
        paths: structureArgs.paths ?? [],
        maxResults: structureArgs.max_results,
      });
    }
    default:
      return { status: "not_implemented", tool: name, parsed_args: args };
  }
}

function toolResponse(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function normalizeSearchArgs(args: unknown) {
  const searchArgs = args as {
    pattern: string;
    mode?: "auto" | "path" | "content" | "both";
    regex?: boolean;
    whole_word?: boolean;
    filters?: { paths?: string[]; extensions?: string[]; exclude?: string[] };
    contextPaths?: string[];
    context_lines?: number;
    max_results?: number;
  };
  return {
    pattern: searchArgs.pattern,
    mode: searchArgs.mode,
    regex: searchArgs.regex,
    whole_word: searchArgs.whole_word,
    filters: searchArgs.filters,
    contextPaths: searchArgs.contextPaths,
    context_lines: searchArgs.context_lines,
    max_results: searchArgs.max_results,
  };
}

function findCatalogFile(catalog: FileCatalog, path: string): CatalogFile | undefined {
  for (const root of catalog.roots) {
    const relative = relativeToRoot(root.root, resolveRootPath(root.root, path));
    const found = root.files.find(
      (file) => file.relativePath === relative || file.absolutePath === path,
    );
    if (found) return found;
  }
  return undefined;
}

function mergeConfig(base: Config, overrides: DeepPartial<Config>, roots?: string[]): Config {
  const merged = deepMerge(base, overrides) as Config;
  if (roots && roots.length > 0) merged.roots = roots;
  return merged;
}

function deepMerge(...sources: unknown[]): unknown {
  const [first, ...rest] = sources;
  if (Array.isArray(first)) return [...first];
  if (!isPlainObject(first)) return first;

  const merged: Record<string, unknown> = { ...first };
  for (const source of rest) {
    if (!isPlainObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (Array.isArray(value)) {
        merged[key] = [...value];
      } else if (isPlainObject(value) && isPlainObject(merged[key])) {
        merged[key] = deepMerge(merged[key], value);
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
