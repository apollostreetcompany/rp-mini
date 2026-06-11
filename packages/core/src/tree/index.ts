import { basename, sep } from "node:path";
import type { FileCatalog } from "../catalog/index.js";
import { canCodemapFile } from "../codemaps/index.js";
import type { Config } from "../config/index.js";
import { estimateTokens } from "../tokens/index.js";

export type FileTreeMode = "auto" | "full" | "folders" | "selected";

export interface FileTreeOptions {
  mode?: FileTreeMode;
  maxDepth?: number;
  maxTokens?: number;
  path?: string;
  selectedPaths?: string[];
  codemapPaths?: string[];
}

export interface FileTreeResult {
  tree: string;
  limit_hit: boolean;
  omitted_total: number;
  wasTruncated: boolean;
  chosenDepth?: number;
  suggestion?: string;
}

export interface FileTreeError {
  error: { code: "not_available_until_selection"; message?: string };
}

interface Node {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: Map<string, Node>;
  assetCatalog?: boolean;
  codemapAvailable?: boolean;
  selected?: boolean;
  fileCount: number;
  dirCount: number;
  anchorSelf?: boolean;
  anchorDescendant?: boolean;
  heuristicAnchor?: boolean;
}

interface RenderProfile {
  mode: Exclude<FileTreeMode, "auto">;
  depthLimit?: number;
  collapseDistantAt?: number;
  selectedOnly?: boolean;
  name: string;
}

const SOURCE_DIR_NAMES = new Set([
  "app",
  "apps",
  "bin",
  "cli",
  "client",
  "cmd",
  "core",
  "lib",
  "package",
  "packages",
  "server",
  "src",
  "source",
  "sources",
  "test",
  "tests",
]);

export function generateFileTree(
  catalog: FileCatalog,
  config: Config,
  options: FileTreeOptions,
): FileTreeResult | FileTreeError {
  const mode = options.mode ?? "auto";
  if (mode === "selected") {
    if (!options.selectedPaths) return { error: { code: "not_available_until_selection" } };
    return renderCatalog(catalog, config, options);
  }

  if (mode === "auto") {
    return renderAuto(catalog, config, options);
  }

  return renderCatalog(catalog, config, options);
}

function renderAuto(
  catalog: FileCatalog,
  config: Config,
  options: FileTreeOptions,
): FileTreeResult {
  const budget = options.maxTokens ?? config.caps.tree_tokens;
  const full = renderCatalog(catalog, config, { ...options, mode: "full" });
  if (estimateTokens(full.tree) <= budget) return full;

  const maxDepth = maxCatalogDepth(catalog);
  const depth3 = options.maxDepth === undefined ? 3 : Math.min(3, options.maxDepth);
  const profiles: RenderProfile[] = [
    { mode: "full", collapseDistantAt: 4, name: "full summarized distant depth >= 4" },
    { mode: "full", depthLimit: depth3, name: `full depth cap ${depth3}` },
    {
      mode: "folders",
      collapseDistantAt: 4,
      name: "directory-only view; selected files shown",
    },
    {
      mode: "folders",
      depthLimit: depth3,
      name: `directory-only view; depth cap ${depth3}; selected files shown`,
    },
    {
      mode: "selected",
      selectedOnly: true,
      name: "selected-only view with summarized root coverage",
    },
  ];

  for (const profile of profiles) {
    const rendered = renderCatalog(
      catalog,
      config,
      {
        ...options,
        mode: profile.mode,
        maxDepth: profile.depthLimit,
      },
      profile,
    );
    if (estimateTokens(rendered.tree) <= budget) {
      return {
        ...rendered,
        limit_hit: true,
        wasTruncated: true,
        chosenDepth: profile.depthLimit ?? maxDepth,
        suggestion: `Auto tree used ${profile.name}. Use max_tokens, max_depth, or path to reshape.`,
      };
    }
  }

  const fallback = renderCatalog(
    catalog,
    config,
    { ...options, mode: "selected" },
    { mode: "selected", selectedOnly: true, collapseDistantAt: 1, name: "root summaries" },
  );
  return {
    ...fallback,
    limit_hit: true,
    wasTruncated: true,
    chosenDepth: 0,
    suggestion: "Auto tree fell back to root summaries plus selected anchors.",
  };
}

function renderCatalog(
  catalog: FileCatalog,
  config: Config,
  options: FileTreeOptions,
  profile?: RenderProfile,
): FileTreeResult {
  const maxDepth = options.maxDepth;
  const rootLines = catalog.roots.flatMap((root) => {
    const basePath = normalize(options.path ?? "");
    const tree = buildRoot(root.root, basename(root.root) || root.root);
    const selectedPaths = new Set((options.selectedPaths ?? []).map(normalize));
    const codemapPaths = new Set((options.codemapPaths ?? []).map(normalize));
    for (const dir of root.dirs) {
      if (!insideBase(dir.relativePath, basePath)) continue;
      addPath(
        tree,
        stripBase(dir.relativePath, basePath),
        "dir",
        dir.relativePath.endsWith(".xcassets"),
      );
    }
    if (options.mode !== "folders" || profile !== undefined) {
      for (const file of root.files) {
        if (!insideBase(file.relativePath, basePath)) continue;
        if (
          options.mode === "selected" &&
          !selectedPaths.has(file.relativePath) &&
          !codemapPaths.has(file.relativePath)
        ) {
          continue;
        }
        addPath(
          tree,
          stripBase(file.relativePath, basePath),
          "file",
          false,
          canCodemapFile(file, config) || codemapPaths.has(file.relativePath),
          selectedPaths.has(file.relativePath),
        );
      }
    }
    if (basePath) tree.name = basePath.split("/").at(-1) ?? tree.name;
    finalizeCounts(tree);
    markAnchors(tree, selectedPaths, codemapPaths, Boolean(basePath));
    return renderNode(tree, "", true, 0, maxDepth, profile);
  });
  return {
    tree: `(+ denotes codemap available)\n${rootLines.join("\n")}\n`,
    limit_hit: false,
    omitted_total: 0,
    wasTruncated: false,
  };
}

function buildRoot(path: string, name: string): Node {
  return { name, path, kind: "dir", children: new Map(), fileCount: 0, dirCount: 0 };
}

function addPath(
  root: Node,
  path: string,
  kind: "dir" | "file",
  assetCatalog = false,
  codemapAvailable = false,
  selected = false,
): void {
  const parts = normalize(path).split("/").filter(Boolean);
  if (parts.length === 0) return;
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    const isLeaf = index === parts.length - 1;
    const childKind = isLeaf ? kind : "dir";
    let child = cursor.children.get(part);
    if (!child) {
      child = {
        name: part,
        path: [...parts.slice(0, index), part].join("/"),
        kind: childKind,
        children: new Map(),
        fileCount: 0,
        dirCount: 0,
      };
      cursor.children.set(part, child);
    }
    if (isLeaf) {
      child.kind = childKind;
      child.assetCatalog ||= assetCatalog;
      child.codemapAvailable ||= codemapAvailable;
      child.selected ||= selected;
    }
    cursor = child;
  }
}

function renderNode(
  node: Node,
  prefix: string,
  isLast: boolean,
  depth: number,
  maxDepth: number | undefined,
  profile?: RenderProfile,
): string[] {
  const label = labelForNode(node, profile);
  const line = depth === 0 ? label : `${prefix}${isLast ? "└── " : "├── "}${label}`;
  const children = visibleChildren(node, profile);
  const overDepth = maxDepth !== undefined && depth >= maxDepth;
  const collapseDistant =
    profile?.collapseDistantAt !== undefined &&
    depth >= profile.collapseDistantAt &&
    node.kind === "dir" &&
    !node.anchorDescendant &&
    !node.anchorSelf;
  if (
    (overDepth || collapseDistant) &&
    node.kind === "dir" &&
    !node.anchorDescendant &&
    !node.anchorSelf &&
    node.fileCount + node.dirCount > 0
  ) {
    return [summaryLine(node, prefix, isLast, depth)];
  }
  if ((overDepth || collapseDistant) && children.length > 0) {
    const selected = children.filter((child) => child.anchorSelf || child.anchorDescendant);
    const hasOther = children.length > selected.length;
    if (selected.length === 0) return [summaryLine(node, prefix, isLast, depth)];
    const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`;
    return [
      line,
      ...selected.flatMap((child, index) =>
        renderNode(
          child,
          childPrefix,
          !hasOther && index === selected.length - 1,
          depth + 1,
          undefined,
          profile,
        ),
      ),
      ...(hasOther
        ? [`${childPrefix}${selected.length === 0 ? "└── " : "├── "}${summaryLabel(node)}`]
        : []),
    ];
  }
  const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`;
  return [
    line,
    ...children.flatMap((child, index) =>
      renderNode(child, childPrefix, index === children.length - 1, depth + 1, maxDepth, profile),
    ),
  ];
}

function visibleChildren(node: Node, profile?: RenderProfile): Node[] {
  const children = [...node.children.values()].filter((child) => {
    if (profile?.selectedOnly) {
      if (node.anchorDescendant) return true;
      return child.anchorSelf || child.anchorDescendant || child.heuristicAnchor;
    }
    if (profile?.mode === "folders") {
      return child.kind === "dir" || child.selected;
    }
    return true;
  });
  return children.sort(
    (a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name),
  );
}

function labelForNode(node: Node, profile?: RenderProfile): string {
  if (
    node.kind === "dir" &&
    profile !== undefined &&
    !node.anchorSelf &&
    !node.anchorDescendant &&
    node.fileCount + node.dirCount > 0
  ) {
    return `${node.name}/ ${summaryLabel(node)}`;
  }
  return `${node.name}${node.assetCatalog ? " (asset catalog)" : ""}${node.selected ? " *" : ""}${node.codemapAvailable ? " +" : ""}`;
}

function summaryLine(node: Node, prefix: string, isLast: boolean, depth: number): string {
  const label = `${node.name}/ ${summaryLabel(node)}`;
  return depth === 0 ? label : `${prefix}${isLast ? "└── " : "├── "}${label}`;
}

function summaryLabel(node: Node): string {
  const parts = [];
  if (node.fileCount > 0)
    parts.push(`${node.fileCount} ${node.fileCount === 1 ? "file" : "files"}`);
  if (node.dirCount > 0) parts.push(`${node.dirCount} ${node.dirCount === 1 ? "dir" : "dirs"}`);
  return `… (${parts.join(", ") || "empty"})`;
}

function finalizeCounts(node: Node): { files: number; dirs: number } {
  if (node.kind === "file") {
    node.fileCount = 1;
    node.dirCount = 0;
    return { files: 1, dirs: 0 };
  }
  let files = 0;
  let dirs = 0;
  for (const child of node.children.values()) {
    const counts = finalizeCounts(child);
    files += counts.files;
    dirs += counts.dirs + (child.kind === "dir" ? 1 : 0);
  }
  node.fileCount = files;
  node.dirCount = dirs;
  return { files, dirs };
}

function markAnchors(
  root: Node,
  selectedPaths: Set<string>,
  codemapPaths: Set<string>,
  pathAnchor: boolean,
): boolean {
  const explicitAnchors = new Set([...selectedPaths, ...codemapPaths]);
  function visit(node: Node, depth: number): boolean {
    node.anchorSelf = explicitAnchors.has(node.path) || (pathAnchor && depth === 0);
    node.heuristicAnchor =
      node.kind === "dir" &&
      (depth === 1 ||
        (explicitAnchors.size === 0 && SOURCE_DIR_NAMES.has(node.name.toLowerCase())));
    let descendant = false;
    for (const child of node.children.values()) {
      if (visit(child, depth + 1)) descendant = true;
    }
    node.anchorDescendant = descendant;
    return Boolean(node.anchorSelf || node.heuristicAnchor || descendant);
  }
  return visit(root, 0);
}

function maxCatalogDepth(catalog: FileCatalog): number {
  const paths = catalog.roots.flatMap((root) => [
    ...root.dirs.map((entry) => entry.relativePath),
    ...root.files.map((entry) => entry.relativePath),
  ]);
  return Math.max(0, ...paths.map((path) => normalize(path).split("/").filter(Boolean).length));
}

function insideBase(path: string, base: string): boolean {
  const normalized = normalize(path);
  return !base || normalized === base || normalized.startsWith(`${base}/`);
}

function stripBase(path: string, base: string): string {
  const normalized = normalize(path);
  return base ? normalized.slice(base.length).replace(/^\/+/, "") : normalized;
}

function normalize(path: string): string {
  return path
    .split(sep)
    .join("/")
    .replace(/^\/+|\/+$/g, "");
}
