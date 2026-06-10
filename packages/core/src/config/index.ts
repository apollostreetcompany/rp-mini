import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type TokenizerConfig = "heuristic" | `tiktoken:${string}`;
export type SelectionScope = "session" | "workspace";
export type EnhancementMode = "rewrite" | "augment" | "preserve";
export type PathDisplay = "relative" | "full";
export type IosIgnorePreset = "auto" | boolean;

export interface PresetConfig {
  include_files?: boolean;
  include_tree?: boolean;
  tree_mode?: "auto" | "full" | "folders" | "selected";
  codemap_usage?: "auto" | "selected" | "none";
  git_inclusion?: "none" | "selected" | "diff";
  meta_prompts?: string[];
}

export interface Config {
  roots: string[];
  tokenizer: TokenizerConfig;
  budgets: {
    discovery: number;
    plan: number;
  };
  caps: {
    search_chars: number;
    structure_tokens: number;
    tree_tokens: number;
    git_patch_lines: number;
    file_size_bytes: number;
  };
  codemaps: {
    languages: string[];
    cache_dir: string;
  };
  ignore: {
    extra: string[];
    ios_preset: IosIgnorePreset;
  };
  search: {
    ripgrep_path?: string;
  };
  tools: {
    apply_edits: boolean;
    file_actions: boolean;
    git: boolean;
  };
  selection: {
    auto_codemaps: boolean;
    persist: boolean;
    scope: SelectionScope;
  };
  context_builder: {
    enhancement: EnhancementMode;
    intent_detection: boolean;
  };
  presets: Record<string, PresetConfig>;
  packager: {
    section_order: string[];
    duplicate_instructions_at_top: boolean;
  };
  concurrency: {
    parse_workers: number;
    search_max: number;
  };
  daemon: {
    keep_alive: boolean;
    idle_timeout_s: number;
    max_rss_mb: number;
  };
  paths: PathDisplay;
}

export type DeepPartial<T> =
  T extends Array<infer U> ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export const defaultConfig: Config = {
  roots: ["."],
  tokenizer: "heuristic",
  budgets: { discovery: 160000, plan: 120000 },
  caps: {
    search_chars: 50000,
    structure_tokens: 6000,
    tree_tokens: 10000,
    git_patch_lines: 300,
    file_size_bytes: 10000000,
  },
  codemaps: {
    languages: [
      "ts",
      "tsx",
      "js",
      "py",
      "swift",
      "go",
      "rust",
      "java",
      "c",
      "cpp",
      "c_sharp",
      "ruby",
      "php",
      "dart",
    ],
    cache_dir: ".rp-mini/codemap-cache",
  },
  ignore: {
    extra: [],
    ios_preset: "auto",
  },
  search: {},
  tools: { apply_edits: true, file_actions: true, git: true },
  selection: { auto_codemaps: true, persist: true, scope: "session" },
  context_builder: { enhancement: "rewrite", intent_detection: true },
  presets: {
    standard: {
      include_files: true,
      include_tree: true,
      tree_mode: "auto",
      codemap_usage: "auto",
      git_inclusion: "none",
      meta_prompts: [],
    },
    plan: {
      include_files: true,
      include_tree: true,
      tree_mode: "auto",
      codemap_usage: "auto",
      git_inclusion: "none",
      meta_prompts: ["Architect"],
    },
    review: {
      include_files: true,
      include_tree: true,
      tree_mode: "auto",
      codemap_usage: "selected",
      git_inclusion: "selected",
      meta_prompts: ["Review"],
    },
    "diff-followup": {
      include_files: false,
      include_tree: false,
      tree_mode: "selected",
      codemap_usage: "none",
      git_inclusion: "diff",
      meta_prompts: [],
    },
  },
  packager: {
    section_order: ["file_map", "file_contents", "git_diff", "meta_prompts", "user_instructions"],
    duplicate_instructions_at_top: false,
  },
  concurrency: { parse_workers: 4, search_max: 4 },
  daemon: { keep_alive: false, idle_timeout_s: 300, max_rss_mb: 1500 },
  paths: "relative",
};

export async function loadConfig(
  rootDir: string,
  overrides: DeepPartial<Config> = {},
  options: LoadConfigOptions = {},
): Promise<Config> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const userConfigPath = join(home, ".config", "rp-mini", "config.json");
  const workspaceConfigPath = join(rootDir, "rp-mini.config.json");

  return deepMerge(
    defaultConfig,
    await readJsonConfig(userConfigPath),
    await readJsonConfig(workspaceConfigPath),
    envToConfig(env),
    overrides,
  ) as Config;
}

async function readJsonConfig(path: string): Promise<DeepPartial<Config>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DeepPartial<Config>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function envToConfig(env: Record<string, string | undefined>): DeepPartial<Config> {
  const result: DeepPartial<Config> = {};
  setNumber(result, ["budgets", "discovery"], env.RP_MINI_BUDGETS_DISCOVERY);
  setNumber(result, ["budgets", "plan"], env.RP_MINI_BUDGETS_PLAN);
  setNumber(result, ["caps", "search_chars"], env.RP_MINI_CAPS_SEARCH_CHARS);
  setNumber(result, ["caps", "structure_tokens"], env.RP_MINI_CAPS_STRUCTURE_TOKENS);
  setNumber(result, ["caps", "tree_tokens"], env.RP_MINI_CAPS_TREE_TOKENS);
  setNumber(result, ["caps", "git_patch_lines"], env.RP_MINI_CAPS_GIT_PATCH_LINES);
  setNumber(result, ["caps", "file_size_bytes"], env.RP_MINI_CAPS_FILE_SIZE_BYTES);
  setNumber(result, ["concurrency", "parse_workers"], env.RP_MINI_CONCURRENCY_PARSE_WORKERS);
  setNumber(result, ["concurrency", "search_max"], env.RP_MINI_CONCURRENCY_SEARCH_MAX);
  setNumber(result, ["daemon", "idle_timeout_s"], env.RP_MINI_DAEMON_IDLE_TIMEOUT_S);
  setNumber(result, ["daemon", "max_rss_mb"], env.RP_MINI_DAEMON_MAX_RSS_MB);
  setBoolean(result, ["tools", "apply_edits"], env.RP_MINI_TOOLS_APPLY_EDITS);
  setBoolean(result, ["tools", "file_actions"], env.RP_MINI_TOOLS_FILE_ACTIONS);
  setBoolean(result, ["tools", "git"], env.RP_MINI_TOOLS_GIT);
  setBoolean(result, ["selection", "auto_codemaps"], env.RP_MINI_SELECTION_AUTO_CODEMAPS);
  setBoolean(result, ["selection", "persist"], env.RP_MINI_SELECTION_PERSIST);
  setBoolean(
    result,
    ["context_builder", "intent_detection"],
    env.RP_MINI_CONTEXT_BUILDER_INTENT_DETECTION,
  );
  setBoolean(
    result,
    ["packager", "duplicate_instructions_at_top"],
    env.RP_MINI_PACKAGER_DUPLICATE_INSTRUCTIONS_AT_TOP,
  );
  setBoolean(result, ["daemon", "keep_alive"], env.RP_MINI_DAEMON_KEEP_ALIVE);
  setString(result, ["tokenizer"], env.RP_MINI_TOKENIZER);
  setString(result, ["codemaps", "cache_dir"], env.RP_MINI_CODEMAPS_CACHE_DIR);
  setString(result, ["selection", "scope"], env.RP_MINI_SELECTION_SCOPE);
  setString(result, ["context_builder", "enhancement"], env.RP_MINI_CONTEXT_BUILDER_ENHANCEMENT);
  setString(result, ["ignore", "ios_preset"], env.RP_MINI_IGNORE_IOS_PRESET);
  setString(result, ["search", "ripgrep_path"], env.RP_MINI_RIPGREP_PATH);
  setString(result, ["paths"], env.RP_MINI_PATHS);
  setStringArray(result, ["roots"], env.RP_MINI_ROOTS);
  setStringArray(result, ["codemaps", "languages"], env.RP_MINI_CODEMAPS_LANGUAGES);
  setStringArray(result, ["ignore", "extra"], env.RP_MINI_IGNORE_EXTRA);
  setStringArray(result, ["packager", "section_order"], env.RP_MINI_PACKAGER_SECTION_ORDER);
  return result;
}

function setNumber(target: DeepPartial<Config>, path: string[], raw: string | undefined): void {
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric config override for ${path.join(".")}: ${raw}`);
  }
  setPath(target, path, value);
}

function setBoolean(target: DeepPartial<Config>, path: string[], raw: string | undefined): void {
  if (raw === undefined) return;
  if (!["true", "false"].includes(raw)) {
    throw new Error(`Invalid boolean config override for ${path.join(".")}: ${raw}`);
  }
  setPath(target, path, raw === "true");
}

function setString(target: DeepPartial<Config>, path: string[], raw: string | undefined): void {
  if (raw !== undefined) setPath(target, path, raw);
}

function setStringArray(
  target: DeepPartial<Config>,
  path: string[],
  raw: string | undefined,
): void {
  if (raw !== undefined)
    setPath(
      target,
      path,
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    cursor[segment] ??= {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
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
