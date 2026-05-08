import { readFile, writeFile, mkdir, stat } from "fs/promises";
import path from "path";

// 優先順位: 環境変数 DATA_DIR > Railway マウント /data > プロジェクト相対 ./data
// Railway では /data を Volume としてマウント済み (永続化)
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.RAILWAY_ENVIRONMENT_NAME ? "/data" : path.join(process.cwd(), "data"));

let _migrated = false;

async function ensureDir() {
  try { await mkdir(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  // 旧パス (./data) からのワンタイム移行: 永続Volumeに既存ファイルがなく、旧パスにあれば写す
  if (!_migrated && DATA_DIR !== path.join(process.cwd(), "data")) {
    _migrated = true;
    const oldDir = path.join(process.cwd(), "data");
    try {
      const { readdir, copyFile } = await import("fs/promises");
      const oldFiles = await readdir(oldDir).catch(() => [] as string[]);
      let migrated = 0;
      for (const f of oldFiles) {
        if (!f.endsWith(".json")) continue;
        const newPath = path.join(DATA_DIR, f);
        try { await stat(newPath); continue; } catch { /* not exists, copy */ }
        await copyFile(path.join(oldDir, f), newPath);
        migrated++;
      }
      if (migrated > 0) console.log(`[data] 旧パスから ${migrated} 件のJSONを ${DATA_DIR} に移行`);
    } catch (e) {
      console.error("[data] 旧パス移行失敗:", e);
    }
  }
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
