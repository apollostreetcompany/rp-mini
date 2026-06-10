import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { buildGitRecencyCache, rankSearchResults, searchFiles } from "./index.js";

const execFileAsync = promisify(execFile);

async function tempRoot(name = "search"): Promise<string> {
  const path = join(tmpdir(), `rp-mini-${name}-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function withConfig(overrides: DeepPartial<Config> = {}): Config {
  const config = structuredClone(defaultConfig);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  if (overrides.ignore) Object.assign(config.ignore, overrides.ignore);
  return config;
}

describe("searchFiles", () => {
  it("searches literal content, regex content, and path-fuzzy catalog entries", async () => {
    const root = await tempRoot("modes");
    await write(
      join(root, "packages/core/src/tokens/index.ts"),
      "export function estimateTokens() {}\n",
    );
    await write(join(root, "packages/core/src/search/index.ts"), "export const search = true;\n");
    const config = withConfig();
    const catalog = await buildCatalog([root], config);

    const literal = await searchFiles(catalog, config, {
      pattern: "estimateTokens",
      mode: "content",
    });
    expect(literal.matches.map((match) => match.path)).toEqual([
      "packages/core/src/tokens/index.ts",
    ]);
    expect(literal.matches[0]?.line).toBe(1);
    expect(literal.limit_hit).toBe(false);

    const regex = await searchFiles(catalog, config, {
      pattern: "estimate[A-Z][A-Za-z]+",
      mode: "content",
      regex: true,
    });
    expect(regex.matches).toHaveLength(1);

    const path = await searchFiles(catalog, config, {
      pattern: "tokn indx",
      mode: "path",
      max_results: 1,
    });
    expect(path.matches[0]?.path).toBe("packages/core/src/tokens/index.ts");
  });

  it("enforces max_results, caps oversized payloads, and reports per-file counts", async () => {
    const root = await tempRoot("caps");
    await write(join(root, "a.ts"), "needle ".repeat(40));
    await write(join(root, "b.ts"), "needle\nneedle\n");
    const config = withConfig({ caps: { search_chars: 220 } });
    const catalog = await buildCatalog([root], config);

    const result = await searchFiles(catalog, config, {
      pattern: "needle",
      mode: "content",
      max_results: 20,
    });

    expect(result.limit_hit).toBe(true);
    expect(result.omitted_total).toBeGreaterThan(0);
    expect(result.suggestion).toContain("narrow");
    expect(result.file_counts.find((entry) => entry.path === "a.ts")?.count).toBeGreaterThan(0);

    const limited = await searchFiles(catalog, withConfig(), {
      pattern: "needle",
      mode: "content",
      max_results: 1,
    });
    expect(limited.matches).toHaveLength(1);
    expect(limited.limit_hit).toBe(true);
  });

  it("respects .gitignore, .repo_ignore, universal ignores, config extras, and extension filters", async () => {
    const root = await tempRoot("ignore");
    await write(join(root, ".gitignore"), "ignored-by-git.ts\n");
    await write(join(root, ".repo_ignore"), "ignored-by-repo.ts\n");
    await write(join(root, "node_modules/pkg/index.ts"), "needle\n");
    await write(join(root, "ignored-by-git.ts"), "needle\n");
    await write(join(root, "ignored-by-repo.ts"), "needle\n");
    await write(join(root, "vendor/ignored.ts"), "needle\n");
    await write(join(root, "src/kept.ts"), "needle\n");
    await write(join(root, "src/kept.md"), "needle\n");
    const config = withConfig({ ignore: { extra: ["vendor/**"] } });
    const catalog = await buildCatalog([root], config);

    const result = await searchFiles(catalog, config, {
      pattern: "needle",
      mode: "content",
      filters: { extensions: [".ts"] },
    });

    expect(result.matches.map((match) => match.path)).toEqual(["src/kept.ts"]);
  });
});

describe("rankSearchResults", () => {
  it("boosts path proximity and git recency", async () => {
    const root = await tempRoot("git-rank");
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await write(join(root, "src/old.ts"), "needle\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "old"], { cwd: root });
    await write(join(root, "src/new.ts"), "needle\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "new"], { cwd: root });

    const recency = await buildGitRecencyCache(root);
    const ranked = rankSearchResults(
      [
        { path: "src/old.ts", line: 1, column: 1, matchText: "needle" },
        { path: "src/new.ts", line: 1, column: 1, matchText: "needle" },
        { path: "docs/new.ts", line: 1, column: 1, matchText: "needle" },
      ],
      { contextPaths: ["src/current.ts"], recency },
    );

    expect(ranked[0]?.path).toBe("src/new.ts");
  });
});
