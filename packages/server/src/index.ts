import {
  defaultConfig,
  generateFileTree,
  getCodeStructures,
  getCatalog,
  readFileSlice,
  relativeToRoot,
  resolveRootPath,
  searchFiles,
  SelectionState,
  type CatalogFile,
  type Config,
  type DeepPartial,
  type FileCatalog,
  type SelectionMode,
  type SelectionSlice,
  type SelectionSnapshot,
} from "@rp-mini/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface RpMiniServerOptions {
  config?: DeepPartial<Config>;
  roots?: string[];
  sessionId?: string;
  now?: () => Date;
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
        op: z.enum([
          "get",
          "add",
          "remove",
          "set",
          "clear",
          "promote",
          "demote",
          "save_profile",
          "load_profile",
          "list_profiles",
        ]),
        mode: z.enum(["full", "slices", "codemap_only"]).optional(),
        paths: z.array(z.string().min(1)).optional(),
        name: z.string().min(1).optional(),
        strict: z.boolean().default(false),
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
  const stateRef: { state?: SelectionState } = {};
  const now = options.now ?? (() => new Date());
  const server = new McpServer({ name: "rp-mini", version: "0.0.0" });

  for (const definition of toolDefinitions) {
    if (definition.enabled && !definition.enabled(config)) continue;
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (args) =>
        toolResponse(
          await handleTool(definition.name, args, {
            config,
            stateRef,
            sessionId: options.sessionId,
            now,
          }),
        ),
    );
  }

  return server;
}

interface HandlerContext {
  config: Config;
  stateRef: { state?: SelectionState };
  sessionId?: string;
  now: () => Date;
}

async function handleTool(name: string, args: unknown, context: HandlerContext): Promise<unknown> {
  const { config } = context;
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
        ...(treeArgs.mode === "selected"
          ? selectedTreeOptions(await selectionState(context, catalog))
          : {}),
      });
    }
    case "get_code_structure": {
      const structureArgs = args as {
        paths?: string[];
        scope?: "selected";
        max_results?: number;
      };
      const catalog = await getCatalog(config.roots, config);
      if (structureArgs.scope === "selected") {
        const state = await selectionState(context, catalog);
        await state.validateFresh();
        const snapshot = state.snapshot();
        if (snapshot.entries.length === 0) {
          return { error: { code: "not_available_until_selection" } };
        }
        const paths = selectedStructurePaths(snapshot);
        return getCodeStructures(catalog, config, {
          paths,
          maxResults: structureArgs.max_results,
        });
      }
      return getCodeStructures(catalog, config, {
        paths: structureArgs.paths ?? [],
        maxResults: structureArgs.max_results,
      });
    }
    case "manage_selection": {
      const catalog = await getCatalog(config.roots, config);
      const state = await selectionState(context, catalog);
      return handleManageSelection(state, args);
    }
    case "workspace_context": {
      const catalog = await getCatalog(config.roots, config);
      const state = await selectionState(context, catalog);
      return workspaceContext(state, catalog, config, args, context.now);
    }
    case "prompt": {
      const catalog = await getCatalog(config.roots, config);
      const state = await selectionState(context, catalog);
      return handlePrompt(state, args);
    }
    default:
      return { status: "not_implemented", tool: name, parsed_args: args };
  }
}

async function selectionState(
  context: HandlerContext,
  catalog: FileCatalog,
): Promise<SelectionState> {
  if (!context.stateRef.state) {
    context.stateRef.state = new SelectionState({
      root: context.config.roots[0] ?? process.cwd(),
      config: context.config,
      catalog,
      sessionId: context.sessionId,
    });
    await context.stateRef.state.load();
  } else {
    context.stateRef.state.updateCatalog(catalog);
  }
  return context.stateRef.state;
}

async function handleManageSelection(state: SelectionState, args: unknown): Promise<unknown> {
  const selectionArgs = args as {
    op: string;
    mode?: "full" | "slices" | "codemap_only";
    paths?: string[];
    slices?: Array<{
      path: string;
      ranges?: Array<{ start_line: number; end_line?: number; description?: string }>;
      description?: string;
    }>;
    view?: "summary" | "files" | "content" | "codemaps";
    name?: string;
    strict?: boolean;
  };
  const mutations = selectionMutations(selectionArgs);
  const missing = mutations.filter((mutation) => !state.getFile(mutation.path)).map((m) => m.path);
  if (selectionArgs.strict && missing.length > 0) {
    return { error: { code: "not_found", paths: missing } };
  }

  switch (selectionArgs.op) {
    case "add":
      await state.add(mutations);
      break;
    case "set":
      await state.set(mutations);
      break;
    case "remove":
      await state.remove(mutations);
      break;
    case "clear":
      await state.clear();
      break;
    case "promote":
      await state.promote(selectionArgs.paths ?? []);
      break;
    case "demote":
      await state.demote(selectionArgs.paths ?? []);
      break;
    case "save_profile":
      if (!selectionArgs.name)
        return { error: { code: "invalid_request", message: "name is required." } };
      await state.saveProfile(selectionArgs.name);
      break;
    case "load_profile":
      if (!selectionArgs.name)
        return { error: { code: "invalid_request", message: "name is required." } };
      await state.loadProfile(selectionArgs.name);
      break;
    case "list_profiles":
      return { profiles: await state.listProfiles() };
  }
  await state.validateFresh();
  return renderSelectionView(state, selectionArgs.view ?? "summary");
}

function selectionMutations(args: {
  mode?: "full" | "slices" | "codemap_only";
  paths?: string[];
  slices?: Array<{
    path: string;
    ranges?: Array<{ start_line: number; end_line?: number; description?: string }>;
    description?: string;
  }>;
}): Array<{ path: string; mode: SelectionMode; slices?: SelectionSlice[] }> {
  const mode = fromWireMode(args.mode);
  const pathMutations = (args.paths ?? []).map((path) => ({ path, mode }));
  const sliceMutations = (args.slices ?? []).map((slice) => ({
    path: slice.path,
    mode: "slices" as const,
    slices: (slice.ranges ?? []).map((range) => ({
      start: range.start_line,
      end: range.end_line ?? range.start_line,
      description: range.description ?? slice.description,
    })),
  }));
  return [...pathMutations, ...sliceMutations];
}

function fromWireMode(mode: "full" | "slices" | "codemap_only" | undefined): SelectionMode {
  if (mode === "codemap_only") return "codemap";
  return mode ?? "full";
}

async function renderSelectionView(
  state: SelectionState,
  view: "summary" | "files" | "content" | "codemaps",
): Promise<unknown> {
  const snapshot = state.snapshot();
  if (view === "summary") {
    return { summary: snapshot.totals, auto_codemap_paths: snapshot.autoCodemapPaths };
  }
  if (view === "files") {
    return {
      files: snapshot.entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        slices: entry.slices,
        tokens: entry.tokens,
        auto: snapshot.autoCodemapPaths.includes(entry.path),
        ...(entry.slices_invalidated ? { slices_invalidated: true } : {}),
      })),
      totals: snapshot.totals,
    };
  }
  if (view === "codemaps") {
    return { codemaps: await codemapBlocks(state, snapshot), totals: snapshot.totals };
  }
  return { content: await contentBlocks(state, snapshot), totals: snapshot.totals };
}

async function handlePrompt(state: SelectionState, args: unknown): Promise<unknown> {
  const promptArgs = args as { op: "get" | "set" | "append" | "clear"; text?: string };
  if (promptArgs.op === "set") await state.setPrompt(promptArgs.text ?? "");
  if (promptArgs.op === "append") await state.appendPrompt(promptArgs.text ?? "");
  if (promptArgs.op === "clear") await state.clearPrompt();
  return state.getPrompt();
}

async function workspaceContext(
  state: SelectionState,
  catalog: FileCatalog,
  config: Config,
  args: unknown,
  now: () => Date,
): Promise<unknown> {
  await state.validateFresh();
  const contextArgs = args as {
    op?: "snapshot" | "export";
    include?: Array<"prompt" | "selection" | "code" | "files" | "tree" | "tokens">;
  };
  const include = contextArgs.include ?? ["prompt", "selection", "code", "files", "tree", "tokens"];
  const snapshot = state.snapshot();
  const sections: Record<string, string> = {};
  if (include.includes("prompt")) sections.prompt = snapshot.prompt;
  if (include.includes("selection"))
    sections.selection = JSON.stringify(selectionJson(snapshot), null, 2);
  if (include.includes("tree")) {
    const tree = generateFileTree(catalog, config, {
      mode: "selected",
      ...selectedTreeOptions(state),
    });
    sections.tree = "tree" in tree ? tree.tree : "";
  }
  if (include.includes("files")) sections.files = await contentBlocks(state, snapshot);
  if (include.includes("code")) sections.code = (await codemapBlocks(state, snapshot)).join("\n");
  const tokenBreakdown = {
    prompt: snapshot.totals.prompt,
    instructions: 0,
    file_tree: sections.tree ? estimateSection(sections.tree) : 0,
    files_full: snapshot.entries
      .filter((entry) => entry.mode === "full")
      .reduce((sum, entry) => sum + entry.tokens.full, 0),
    files_slices: snapshot.entries
      .filter((entry) => entry.mode === "slices")
      .reduce((sum, entry) => sum + entry.tokens.slicesTotal, 0),
    codemaps: snapshot.entries
      .filter((entry) => entry.mode === "codemap")
      .reduce((sum, entry) => sum + entry.tokens.codemap, 0),
    total: 0,
  };
  tokenBreakdown.total =
    tokenBreakdown.prompt +
    tokenBreakdown.instructions +
    tokenBreakdown.file_tree +
    tokenBreakdown.files_full +
    tokenBreakdown.files_slices +
    tokenBreakdown.codemaps;
  if (include.includes("tokens")) sections.tokens = JSON.stringify(tokenBreakdown, null, 2);
  const payload = assembleSections(sections);
  const contentHash = sha256(payload);
  const response: Record<string, unknown> = {
    content_hash: contentHash,
    sections,
    tokens: tokenBreakdown,
    selection: selectionJson(snapshot),
  };
  if ((contextArgs.op ?? "snapshot") === "export") {
    const path = join(
      config.roots[0] ?? process.cwd(),
      ".rp-mini",
      "exports",
      `${timestamp(now())}-${contentHash.slice(0, 8)}.md`,
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, payload, "utf8");
    response.path = path;
  }
  return response;
}

function selectedTreeOptions(state: SelectionState) {
  const snapshot = state.snapshot();
  return {
    selectedPaths: snapshot.entries
      .filter((entry) => !snapshot.autoCodemapPaths.includes(entry.path))
      .map((entry) => entry.path),
    codemapPaths: snapshot.entries
      .filter((entry) => entry.mode === "codemap" || snapshot.autoCodemapPaths.includes(entry.path))
      .map((entry) => entry.path),
  };
}

function selectedStructurePaths(snapshot: SelectionSnapshot): string[] {
  return snapshot.entries
    .filter((entry) => entry.mode === "codemap" || entry.mode === "full" || entry.mode === "slices")
    .map((entry) => entry.path)
    .sort();
}

async function contentBlocks(state: SelectionState, snapshot: SelectionSnapshot): Promise<string> {
  const blocks: string[] = [];
  for (const entry of snapshot.entries
    .filter((item) => item.mode !== "codemap")
    .sort((a, b) => a.path.localeCompare(b.path))) {
    const file = state.getFile(entry.path);
    if (!file) continue;
    const content = await readFile(file.absolutePath, "utf8");
    const language = entry.path.split(".").at(-1) ?? "";
    if (entry.mode === "full") {
      blocks.push(`### ${entry.path}\n\`\`\`${language}\n${content}\`\`\``);
    } else {
      const lines = content.split(/(?<=\n)/);
      const segments = entry.slices.map((slice) => {
        const label = `(lines ${slice.start}-${slice.end}${slice.description ? `: ${slice.description}` : ""})`;
        return `${label}\n\`\`\`${language}\n${lines.slice(slice.start - 1, slice.end).join("")}\`\`\``;
      });
      blocks.push(`### ${entry.path}\n${segments.join("\n")}`);
    }
  }
  return blocks.join("\n\n");
}

async function codemapBlocks(
  state: SelectionState,
  snapshot: SelectionSnapshot,
): Promise<string[]> {
  const blocks: string[] = [];
  for (const entry of snapshot.entries
    .filter((item) => item.mode === "codemap")
    .sort((a, b) => a.path.localeCompare(b.path))) {
    const text = await state.codemapTextFor(entry.path);
    if (text) blocks.push(text);
  }
  return blocks;
}

function selectionJson(snapshot: SelectionSnapshot) {
  return {
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      slices: entry.slices,
      auto: snapshot.autoCodemapPaths.includes(entry.path),
      ...(entry.slices_invalidated ? { slices_invalidated: true } : {}),
    })),
    totals: snapshot.totals,
  };
}

function assembleSections(sections: Record<string, string>): string {
  return Object.keys(sections)
    .sort()
    .map((name) => `## ${name}\n\n${sections[name] ?? ""}`.trimEnd())
    .join("\n\n");
}

function estimateSection(text: string): number {
  return Math.ceil((Buffer.byteLength(text, "utf8") / 4) * 1.05);
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
