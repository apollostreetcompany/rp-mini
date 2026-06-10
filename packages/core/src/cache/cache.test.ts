import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { atomicWriteJson, cacheDir, readJsonIfValid } from "./index.js";

describe("cache helpers", () => {
  it("resolves the workspace cache directory", () => {
    expect(cacheDir("/repo/root")).toBe(join("/repo/root", ".rp-mini"));
  });

  it("writes valid JSON atomically without temp droppings", async () => {
    const dir = join(tmpdir(), `rp-mini-cache-${crypto.randomUUID()}`);
    const file = join(dir, "catalog.json");

    await atomicWriteJson(file, { ok: true, count: 1 });

    await expect(readJsonIfValid<{ ok: boolean; count: number }>(file)).resolves.toEqual({
      ok: true,
      count: 1,
    });
    expect(await readFile(file, "utf8")).toContain('"ok": true');
    expect((await readdir(dir)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("survives concurrent writers with valid JSON and no temp droppings", async () => {
    const dir = join(tmpdir(), `rp-mini-cache-race-${crypto.randomUUID()}`);
    const file = join(dir, "catalog.json");

    await Promise.all([
      atomicWriteJson(file, {
        writer: "a",
        values: Array.from({ length: 100 }, (_, index) => index),
      }),
      atomicWriteJson(file, {
        writer: "b",
        values: Array.from({ length: 100 }, (_, index) => index * 2),
      }),
    ]);

    const parsed = await readJsonIfValid<{ writer: string; values: number[] }>(file);
    expect(["a", "b"]).toContain(parsed?.writer);
    expect(parsed?.values).toHaveLength(100);
    expect((await readdir(dir)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("returns null for missing or invalid JSON", async () => {
    const dir = join(tmpdir(), `rp-mini-cache-invalid-${crypto.randomUUID()}`);
    const file = join(dir, "bad.json");

    await expect(readJsonIfValid(file)).resolves.toBeNull();
  });
});
