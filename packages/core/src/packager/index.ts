import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FileCatalog } from "../catalog/index.js";
import { getCodeStructures, languageForPath } from "../codemaps/index.js";
import type { Config, PresetConfig } from "../config/index.js";
import type { SelectionEntry, SelectionSnapshot } from "../selection/index.js";
import { generateFileTree } from "../tree/index.js";
import { estimateTokens } from "../tokens/index.js";

export type SectionName =
  | "file_map"
  | "file_contents"
  | "git_diff"
  | "meta_prompts"
  | "user_instructions";

export interface ResolvedPreset {
  name: string;
  config: Required<PresetConfig>;
}

export interface PackagedSection {
  name: SectionName;
  text: string;
}

export interface PackagedPayload {
  text: string;
  sections: PackagedSection[];
  preset: string;
  tokenBreakdown: TokenBreakdown;
  contentHash: string;
}

export interface TokenBreakdown {
  prompt: number;
  instructions: number;
  file_tree: number;
  files_full: number;
  files_slices: number;
  codemaps: number;
  git_diff: number;
  meta_prompts: number;
  total: number;
}

export interface PackagerOptions {
  root: string;
  catalog: FileCatalog;
  preset?: string;
  responseType?: string;
  instructions?: string;
  gitDiffText?: string;
  readFile?: (path: string) => Promise<string>;
  codemapTextFor?: (path: string) => Promise<string>;
  now?: () => Date;
}

export interface Receipt {
  schema: "rp-mini-receipt@1";
  task: string;
  generated_at: string;
  preset: string;
  budget: number;
  files: Array<{ path: string; mode: SelectionEntry["mode"]; tokens: number }>;
  token_breakdown: TokenBreakdown;
  content_hash: string;
  git: { branch: string | null; head: string | null } | null;
}

const REVIEW_HOTWORDS = [
  "review mode",
  "code review",
  "review changes",
  "review the changes",
  "review the diff",
  "review the pr",
  "review this pr",
  "review pull request",
  "review my changes",
  "review my pr",
  "git diff",
  "pull request",
  "pr review",
  "compare branch",
  "compare main",
  "compare master",
];

const execFileAsync = promisify(execFile);

const META_PROMPTS: Record<string, string> = {
  Architect: loadMetaPrompt("architect.md"),
  Review: loadMetaPrompt("review.md"),
  MVP: "Focus context on routes, entrypoints, build configuration, manifests, and the smallest user-visible path that proves the MVP works.",
};

export function detectIntent(responseType?: string, instructions?: string): "review" | null {
  if (responseType?.toLowerCase() === "review") return "review";
  const haystack = (instructions ?? "").toLowerCase();
  if (!haystack) return null;
  if (REVIEW_HOTWORDS.some((phrase) => haystack.includes(phrase))) return "review";
  const tokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
  if (tokens.has("git") && (tokens.has("diff") || tokens.has("diffs"))) return "review";
  return null;
}

export function resolvePreset(
  config: Config,
  options: { preset?: string; responseType?: string; instructions?: string },
): ResolvedPreset {
  const name =
    options.preset ??
    (options.responseType && config.presets[options.responseType]
      ? options.responseType
      : undefined) ??
    (detectIntent(options.responseType, options.instructions) === "review" ? "review" : "standard");
  const preset = config.presets[name] ?? config.presets.standard;
  return {
    name: config.presets[name] ? name : "standard",
    config: {
      include_files: preset?.include_files ?? true,
      include_tree: preset?.include_tree ?? true,
      tree_mode: preset?.tree_mode ?? "auto",
      codemap_usage: preset?.codemap_usage ?? "auto",
      git_inclusion: preset?.git_inclusion ?? "none",
      meta_prompts: preset?.meta_prompts ?? [],
    },
  };
}

export async function assemblePayload(
  snapshot: SelectionSnapshot,
  config: Config,
  opts: PackagerOptions,
): Promise<PackagedPayload> {
  const preset = resolvePreset(config, {
    preset: opts.preset,
    responseType: opts.responseType,
    instructions: opts.instructions ?? snapshot.prompt,
  });
  const snippets = new Map<SectionName, string>();

  const fileMap = await buildFileMap(snapshot, config, opts, preset.config);
  if (fileMap) snippets.set("file_map", `<file_map>\n${fileMap}\n</file_map>\n`);

  const fileContents = preset.config.include_files ? await buildFileContents(snapshot, opts) : "";
  if (fileContents)
    snippets.set("file_contents", `<file_contents>\n${fileContents}\n</file_contents>\n`);

  if (preset.config.git_inclusion !== "none" && opts.gitDiffText?.trim()) {
    snippets.set("git_diff", `<git_diff>\n${opts.gitDiffText.trimEnd()}\n</git_diff>\n`);
  }

  const metaPrompts = buildMetaPrompts(preset.config.meta_prompts);
  if (metaPrompts) snippets.set("meta_prompts", metaPrompts);

  const userInstructions = buildUserInstructions(snapshot.prompt);
  if (userInstructions) snippets.set("user_instructions", userInstructions);

  const ordered = orderedSections(config, snippets);
  const mainText = ordered.map((section) => section.text).join("\n");
  const text =
    config.packager.duplicate_instructions_at_top && userInstructions
      ? `${userInstructions}\n${mainText}`.trimEnd()
      : mainText.trimEnd();
  const tokenBreakdown = buildTokenBreakdown(snapshot, ordered, text);
  return {
    text,
    sections: ordered,
    preset: preset.name,
    tokenBreakdown,
    contentHash: sha256(text),
  };
}

export async function buildReceipt(
  snapshot: SelectionSnapshot,
  payload: PackagedPayload,
  config: Config,
  opts: Pick<PackagerOptions, "root" | "now">,
): Promise<Receipt> {
  return {
    schema: "rp-mini-receipt@1",
    task: snapshot.prompt.split(/\r?\n/)[0] ?? "",
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
    preset: payload.preset,
    budget: payload.preset === "plan" ? config.budgets.plan : config.budgets.discovery,
    files: snapshot.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      tokens: tokensForEntry(entry),
    })),
    token_breakdown: payload.tokenBreakdown,
    content_hash: payload.contentHash,
    git: await gitState(opts.root),
  };
}

async function buildFileMap(
  snapshot: SelectionSnapshot,
  config: Config,
  opts: PackagerOptions,
  preset: Required<PresetConfig>,
): Promise<string> {
  const parts: string[] = [];
  if (preset.include_tree) {
    const selectedPaths = snapshot.entries
      .filter((entry) => !snapshot.autoCodemapPaths.includes(entry.path))
      .map((entry) => entry.path);
    const codemapPaths = codemapEntries(snapshot, preset.codemap_usage).map((entry) => entry.path);
    const tree = generateFileTree(opts.catalog, config, {
      mode: preset.tree_mode,
      selectedPaths,
      codemapPaths,
    });
    if ("tree" in tree && tree.tree.trim()) parts.push(tree.tree.trimEnd());
  }
  const codemaps = await Promise.all(
    codemapEntries(snapshot, preset.codemap_usage).map(async (entry) => {
      const text =
        opts.codemapTextFor !== undefined
          ? await opts.codemapTextFor(entry.path)
          : await codemapTextFor(opts.catalog, config, entry.path);
      return text.trimEnd();
    }),
  );
  parts.push(...codemaps.filter(Boolean));
  return parts.join("\n\n");
}

async function buildFileContents(
  snapshot: SelectionSnapshot,
  opts: PackagerOptions,
): Promise<string> {
  const blocks: string[] = [];
  for (const entry of snapshot.entries
    .filter((item) => item.mode !== "codemap")
    .sort((a, b) => a.path.localeCompare(b.path))) {
    const content = await readSelectionFile(entry.path, opts);
    const language = fenceLanguage(entry.path);
    if (entry.mode === "full") {
      blocks.push(`File: ${entry.path}\n\`\`\`${language}\n${content.trimEnd()}\n\`\`\``);
      continue;
    }
    const lines = content.split(/(?<=\n)/);
    const segments = entry.slices.map((slice) => {
      const label = `(lines ${slice.start}-${slice.end}${slice.description ? `: ${slice.description}` : ""})`;
      return `${label}\n\`\`\`${language}\n${lines
        .slice(slice.start - 1, slice.end)
        .join("")
        .trimEnd()}\n\`\`\``;
    });
    blocks.push(`File: ${entry.path}\n${segments.join("\n\n")}`);
  }
  return blocks.join("\n\n");
}

function buildMetaPrompts(names: string[]): string {
  return names
    .map((name, index) => {
      const text = (META_PROMPTS[name] ?? name).trim();
      return `<meta prompt ${index + 1} = "${escapeAttribute(name)}">\n${text}\n</meta prompt ${index + 1}>`;
    })
    .join("\n\n");
}

function buildUserInstructions(prompt: string): string {
  return prompt.trim() ? `<user_instructions>\n${prompt.trimEnd()}\n</user_instructions>\n` : "";
}

function orderedSections(config: Config, snippets: Map<SectionName, string>): PackagedSection[] {
  const configured = config.packager.section_order as SectionName[];
  const seen = new Set<SectionName>();
  const ordered: PackagedSection[] = [];
  for (const name of configured) {
    const text = snippets.get(name);
    if (!text) continue;
    seen.add(name);
    ordered.push({ name, text: text.trimEnd() });
  }
  for (const [name, text] of snippets) {
    if (!seen.has(name)) ordered.push({ name, text: text.trimEnd() });
  }
  return ordered;
}

function codemapEntries(
  snapshot: SelectionSnapshot,
  usage: Required<PresetConfig>["codemap_usage"],
): SelectionEntry[] {
  if (usage === "none") return [];
  return snapshot.entries
    .filter((entry) => {
      if (entry.mode !== "codemap") return false;
      return usage === "auto" || !snapshot.autoCodemapPaths.includes(entry.path);
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function readSelectionFile(path: string, opts: PackagerOptions): Promise<string> {
  if (opts.readFile) return opts.readFile(path);
  const file = opts.catalog.roots
    .flatMap((root) => root.files)
    .find((entry) => entry.relativePath === path);
  if (!file) throw new Error(`Selected file not found: ${path}`);
  return readFile(file.absolutePath, "utf8");
}

async function codemapTextFor(catalog: FileCatalog, config: Config, path: string): Promise<string> {
  const result = await getCodeStructures(catalog, config, { paths: [path], maxResults: 1 });
  return result.files[0]?.text ?? "";
}

function buildTokenBreakdown(
  snapshot: SelectionSnapshot,
  sections: PackagedSection[],
  text: string,
): TokenBreakdown {
  const bySection = new Map(
    sections.map((section) => [section.name, estimateTokens(section.text)]),
  );
  const filesFull = snapshot.entries
    .filter((entry) => entry.mode === "full")
    .reduce((sum, entry) => sum + entry.tokens.full, 0);
  const filesSlices = snapshot.entries
    .filter((entry) => entry.mode === "slices")
    .reduce((sum, entry) => sum + entry.tokens.slicesTotal, 0);
  const codemaps = snapshot.entries
    .filter((entry) => entry.mode === "codemap")
    .reduce((sum, entry) => sum + entry.tokens.codemap, 0);
  return {
    prompt: snapshot.totals.prompt,
    instructions: bySection.get("user_instructions") ?? 0,
    file_tree: bySection.get("file_map") ?? 0,
    files_full: filesFull,
    files_slices: filesSlices,
    codemaps,
    git_diff: bySection.get("git_diff") ?? 0,
    meta_prompts: bySection.get("meta_prompts") ?? 0,
    total: estimateTokens(text),
  };
}

function tokensForEntry(entry: SelectionEntry): number {
  if (entry.mode === "full") return entry.tokens.full;
  if (entry.mode === "slices") return entry.tokens.slicesTotal;
  return entry.tokens.codemap;
}

function fenceLanguage(path: string): string {
  const language = languageForPath(path);
  if (language === "rust") return "rust";
  if (language) return language;
  const extension = extname(path).replace(/^\./, "");
  if (extension === "md" || extension === "markdown") return "markdown";
  return extension;
}

async function gitState(root: string): Promise<Receipt["git"]> {
  try {
    const [branch, head] = await Promise.all([
      execFileAsync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]),
      execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]),
    ]);
    return {
      branch: branch.stdout.trim() || null,
      head: head.stdout.trim() || null,
    };
  } catch {
    return null;
  }
}

function loadMetaPrompt(file: string): string {
  try {
    return readFileSync(
      fileURLToPath(new URL(`../../../../shared-prompts/meta/${file}`, import.meta.url)),
      "utf8",
    ).trim();
  } catch {
    if (file === "architect.md")
      return "Plan before editing. Identify modules, risks, steps, and verification.";
    return "Review changes with severity-ranked findings, tests, and risks.";
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
