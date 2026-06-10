import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/index.js";
import { defaultConfig, type Config, type DeepPartial } from "../config/index.js";
import { SelectionState } from "../selection/index.js";
import {
  assemblePayload,
  buildReceipt,
  detectIntent,
  resolvePreset,
  type PackagerOptions,
} from "./index.js";

async function tempRoot(name = "packager"): Promise<string> {
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
  if (overrides.budgets) Object.assign(config.budgets, overrides.budgets);
  if (overrides.caps) Object.assign(config.caps, overrides.caps);
  if (overrides.selection) Object.assign(config.selection, overrides.selection);
  if (overrides.presets) {
    config.presets = {
      ...config.presets,
      ...(overrides.presets as Record<string, Config["presets"][string]>),
    };
  }
  if (overrides.packager) Object.assign(config.packager, overrides.packager);
  return config;
}

async function fixture(overrides: DeepPartial<Config> = {}) {
  const root = await tempRoot();
  await write(
    join(root, "src", "alpha.ts"),
    [
      "import type { Beta } from './beta';",
      "export function alpha(beta: Beta): string {",
      "  return beta.name;",
      "}",
      "",
    ].join("\n"),
  );
  await write(join(root, "src", "beta.ts"), "export interface Beta { name: string }\n");
  await write(join(root, "README.md"), "# Fixture\n");
  const config = withConfig({
    selection: { persist: false },
    ...overrides,
  });
  const catalog = await buildCatalog([root], config);
  const state = new SelectionState({ root, config, catalog, sessionId: "packager" });
  await state.add([{ path: "src/alpha.ts", mode: "full" }]);
  await state.add([
    {
      path: "README.md",
      mode: "slices",
      slices: [{ start: 1, end: 1, description: "overview" }],
    },
  ]);
  await state.setPrompt("Build the smallest useful feature.\nKeep it scoped.");
  const opts: PackagerOptions = {
    root,
    catalog,
    readFile: async (path) => {
      const file = state.getFile(path);
      if (!file) throw new Error(`missing ${path}`);
      return readFile(file.absolutePath, "utf8");
    },
    codemapTextFor: (path) => state.codemapTextFor(path),
    now: () => new Date("2026-06-10T00:00:00.000Z"),
  };
  return { root, config, catalog, state, snapshot: state.snapshot(), opts };
}

describe("detectIntent", () => {
  it("detects review hotwords and git diff token fallback", () => {
    expect(detectIntent("review")).toBe("review");
    expect(detectIntent(undefined, "Please review this PR before merge")).toBe("review");
    expect(detectIntent(undefined, "Can you compare main against this branch?")).toBe("review");
    expect(detectIntent(undefined, "Look at the git changes and diffs")).toBe("review");
    expect(detectIntent("plan", "Plan a migration")).toBeNull();
    expect(detectIntent(undefined, "Build the feature")).toBeNull();
  });
});

describe("resolvePreset", () => {
  it("uses explicit preset, then review intent, then standard default", () => {
    const config = withConfig();
    expect(resolvePreset(config, { preset: "plan" }).name).toBe("plan");
    expect(resolvePreset(config, { responseType: "review" }).name).toBe("review");
    expect(resolvePreset(config, { instructions: "review the diff" }).name).toBe("review");
    expect(resolvePreset(config, {}).name).toBe("standard");
    expect(config.presets.mvp).toBeDefined();
  });
});

describe("assemblePayload", () => {
  it("orders XML sections according to config and renders a stable full payload", async () => {
    const { snapshot, config, opts } = await fixture({
      packager: {
        section_order: ["user_instructions", "meta_prompts", "file_contents", "file_map"],
      },
    });

    const payload = await assemblePayload(snapshot, config, { ...opts, preset: "plan" });

    expect(payload.sections.map((section) => section.name)).toEqual([
      "user_instructions",
      "meta_prompts",
      "file_contents",
      "file_map",
    ]);
    expect(normalizeTempTreeName(payload.text)).toMatchInlineSnapshot(`
      "<user_instructions>
      Build the smallest useful feature.
      Keep it scoped.
      </user_instructions>
      <meta prompt 1 = "Architect">
      Plan before editing. Identify the relevant modules, ownership boundaries, data flow, risks, and verification steps. Prefer the smallest coherent implementation path and call out assumptions that need confirmation.
      </meta prompt 1>
      <file_contents>
      File: README.md
      (lines 1-1: overview)
      \`\`\`markdown
      # Fixture
      \`\`\`

      File: src/alpha.ts
      \`\`\`ts
      import type { Beta } from './beta';
      export function alpha(beta: Beta): string {
        return beta.name;
      }
      \`\`\`
      </file_contents>
      <file_map>
      (+ denotes codemap available)
      rp-mini-packager-<uuid>
      ├── src
      │   ├── alpha.ts * +
      │   └── beta.ts +
      └── README.md *

      File: src/beta.ts
      Imports:
      ---

      Interfaces:
        - Beta
          Properties:
            - name: string

      Exports:
        - export interface Beta { name: string }
      ---
      </file_map>"
    `);
  });

  it("supports duplicate top instructions and omits empty sections", async () => {
    const { snapshot, config, opts } = await fixture({
      packager: { duplicate_instructions_at_top: true },
      presets: { promptOnly: { include_files: false, include_tree: false, codemap_usage: "none" } },
    });

    const payload = await assemblePayload(snapshot, config, { ...opts, preset: "promptOnly" });

    expect(payload.text.startsWith("<user_instructions>")).toBe(true);
    expect(payload.text.match(/<user_instructions>/g)).toHaveLength(2);
    expect(payload.text).not.toContain("<file_map>");
    expect(payload.text).not.toContain("<file_contents>");
  });

  it("shapes codemap and file sections by preset", async () => {
    const { snapshot, config, opts } = await fixture();

    const standard = await assemblePayload(snapshot, config, { ...opts, preset: "standard" });
    const selected = await assemblePayload(snapshot, config, { ...opts, preset: "review" });
    const diffOnly = await assemblePayload(snapshot, config, {
      ...opts,
      preset: "diff-followup",
      gitDiffText: "diff --git a/src/alpha.ts b/src/alpha.ts",
    });

    expect(standard.text).toContain("File: src/beta.ts");
    expect(selected.text).not.toContain("File: src/beta.ts\nImports:");
    expect(selected.text).toContain('<meta prompt 1 = "Review">');
    expect(diffOnly.text).toContain("<git_diff>");
    expect(diffOnly.text).not.toContain("<file_map>");
    expect(diffOnly.text).not.toContain("<file_contents>");
  });
});

function normalizeTempTreeName(text: string): string {
  return text.replace(/rp-mini-packager-[0-9a-f-]+/g, "rp-mini-packager-<uuid>");
}

describe("buildReceipt", () => {
  it("emits stable technical receipt fields with git best-effort nullable", async () => {
    const { snapshot, config, opts } = await fixture({
      budgets: { plan: 42 },
    });
    const payload = await assemblePayload(snapshot, config, { ...opts, preset: "plan" });
    const receipt = await buildReceipt(snapshot, payload, config, opts);
    const second = await buildReceipt(snapshot, payload, config, opts);

    expect(receipt).toMatchObject({
      schema: "rp-mini-receipt@1",
      task: "Build the smallest useful feature.",
      generated_at: "2026-06-10T00:00:00.000Z",
      preset: "plan",
      budget: 42,
      content_hash: payload.contentHash,
      git: null,
    });
    expect(receipt.content_hash).toBe(second.content_hash);
    expect(receipt.files.map((file) => [file.path, file.mode])).toEqual([
      ["README.md", "slices"],
      ["src/alpha.ts", "full"],
      ["src/beta.ts", "codemap"],
    ]);
    expect(receipt.token_breakdown.total).toBeGreaterThan(0);
  });
});
