import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export function cacheDir(root: string): string {
  return join(root, ".rp-mini");
}

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${crypto.randomUUID()}.tmp-${Date.now()}`);
  const json = `${JSON.stringify(data, null, 2)}\n`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "wx");
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, file);

    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonIfValid<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
