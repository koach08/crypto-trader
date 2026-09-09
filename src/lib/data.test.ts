import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

/**
 * loadData は全ての失敗で fallback を返す。そのため「まだ保存していない」と
 * 「読めなかった」の区別がつかない。コア保有台帳をこれで読むと、ボリュームが
 * 読めなかっただけで「1 枚も持っていない」に化け、実弾で買い直しが起きる。
 */
let dir: string;
let mod: typeof import("./data");

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crypto-data-"));
  process.env.DATA_DIR = dir;
  mod = await import("./data");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("loadDataStrict", () => {
  it("ファイルがまだ無いときは empty を返す (loadData と同じ)", async () => {
    const empty = { lots: [] };
    await expect(mod.loadDataStrict("not-saved-yet", empty)).resolves.toEqual(empty);
    await expect(mod.loadData("not-saved-yet", empty)).resolves.toEqual(empty);
  });

  it("保存した中身をそのまま返す", async () => {
    await mod.saveData("core-holding-test", { lots: [{ pair: "BTC/JPY", amount: 0.003 }] });
    await expect(mod.loadDataStrict("core-holding-test", { lots: [] })).resolves.toEqual({
      lots: [{ pair: "BTC/JPY", amount: 0.003 }],
    });
  });

  it("壊れていたら投げる。loadData は黙って空を返してしまう", async () => {
    await writeFile(path.join(dir, "broken.json"), "{ これは JSON では", "utf-8");
    const empty = { lots: [] };

    // 従来の読み方: 破損が「空」に化ける
    await expect(mod.loadData("broken", empty)).resolves.toEqual(empty);

    // 新しい読み方: 空と区別できる
    await expect(mod.loadDataStrict("broken", empty)).rejects.toThrow();
  });
});
