import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

async function ensureDir() {
  try { await mkdir(DATA_DIR, { recursive: true }); } catch { /* exists */ }
}

export async function loadData<T>(key: string, fallback: T): Promise<T> {
  await ensureDir();
  const filePath = path.join(DATA_DIR, `${key}.json`);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function saveData<T>(key: string, data: T): Promise<void> {
  await ensureDir();
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(DATA_DIR, `${safe}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
