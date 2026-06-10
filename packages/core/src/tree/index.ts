import { basename, sep } from "node:path";
import type { FileCatalog } from "../catalog/index.js";
import type { Config } from "../config/index.js";
import { estimateTokens } from "../tokens/index.js";

export type FileTreeMode = "auto" | "full" | "folders" | "selected";

export interface FileTreeOptions {
  mode?: FileTreeMode;
  maxDepth?: number;
  path?: string;
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
}

export function generateFileTree(
  catalog: FileCatalog,
  config: Config,
  options: FileTreeOptions,
): FileTreeResult | FileTreeError {
  const mode = options.mode ?? "auto";
  if (mode === "selected") {
    return { error: { code: "not_available_until_selection" } };
  }

  if (mode === "auto") {
    const maxDepth = maxCatalogDepth(catalog);
    for (let depth = maxDepth; depth >= 0; depth -= 1) {
      const rendered = renderCatalog(catalog, { ...options, mode: "full", maxDepth: depth });
      if (estimateTokens(rendered.tree) <= config.caps.tree_tokens || depth === 0) {
        const truncated = depth < maxDepth;
        return {
          ...rendered,
          limit_hit: truncated,
          wasTruncated: truncated,
          chosenDepth: depth,
          ...(truncated ? { suggestion: "Use max_depth or path to focus the tree." } : {}),
        };
      }
    }
  }

  return renderCatalog(catalog, options);
}

function renderCatalog(catalog: FileCatalog, options: FileTreeOptions): FileTreeResult {
  const maxDepth = options.maxDepth;
  const rootLines = catalog.roots.flatMap((root) => {
    const basePath = normalize(options.path ?? "");
    const tree = buildRoot(root.root, basename(root.root) || root.root);
    for (const dir of root.dirs) {
      if (!insideBase(dir.relativePath, basePath)) continue;
      addPath(
        tree,
        stripBase(dir.relativePath, basePath),
        "dir",
        dir.relativePath.endsWith(".xcassets"),
      );
    }
    if (options.mode !== "folders") {
      for (const file of root.files) {
        if (!insideBase(file.relativePath, basePath)) continue;
        addPath(tree, stripBase(file.relativePath, basePath), "file");
      }
    }
    if (basePath) tree.name = basePath.split("/").at(-1) ?? tree.name;
    return renderNode(tree, "", true, 0, maxDepth);
  });
  return {
    tree: `${rootLines.join("\n")}\n`,
    limit_hit: false,
    omitted_total: 0,
    wasTruncated: false,
  };
}

function buildRoot(path: string, name: string): Node {
  return { name, path, kind: "dir", children: new Map() };
}

function addPath(root: Node, path: string, kind: "dir" | "file", assetCatalog = false): void {
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
      };
      cursor.children.set(part, child);
    }
    if (isLeaf) {
      child.kind = childKind;
      child.assetCatalog ||= assetCatalog;
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
): string[] {
  const label = `${node.name}${node.assetCatalog ? " (asset catalog)" : ""}`;
  const line = depth === 0 ? label : `${prefix}${isLast ? "└── " : "├── "}${label}`;
  if (maxDepth !== undefined && depth >= maxDepth) return [line];
  const children = [...node.children.values()].sort(
    (a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name),
  );
  const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`;
  return [
    line,
    ...children.flatMap((child, index) =>
      renderNode(child, childPrefix, index === children.length - 1, depth + 1, maxDepth),
    ),
  ];
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
