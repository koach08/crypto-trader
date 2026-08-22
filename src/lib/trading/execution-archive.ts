/**
 * 約定履歴の保管庫。
 *
 * 【なぜ要るか】取引所の getexecutions は古い分を返しきらない。毎回取りに行って
 * 「取れた分だけ」で集計すると、**過去の売買が勝手に消えて数字が縮む**。
 * 実際、同じ本番で購入代金が ¥1,392,447 と ¥1,211,654 の2通り出ていた。
 * 主指標 (買った暗号資産に対する損益) の分母がこれなので、揺れると意味を成さない。
 *
 * 取得できたものを id で重複排除しながら貯めて、集計はその和集合から出す。
 * 一度見た約定は消えないので、集計は単調に増える。
 */
import { loadData, saveData } from "../data";
import type { ExecutionRecord } from "../exchanges/types";
import type { IExchange } from "../exchanges/types";

/** /api/bot/lifetime と同じキーを共有する。片方だけ別の値を持つ状態を作らない。 */
const CACHE_KEY = "bitflyer-executions";

export interface ExecutionArchive {
  byPair: Record<string, ExecutionRecord[]>;
  lastFetchedAt: number;
}

export function mergeExecutions(
  stored: ExecutionRecord[],
  fetched: ExecutionRecord[]
): ExecutionRecord[] {
  const map = new Map<string, ExecutionRecord>();
  for (const r of stored) map.set(r.id, r);
  for (const r of fetched) map.set(r.id, r);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export async function loadArchive(): Promise<ExecutionArchive> {
  const a = await loadData<ExecutionArchive>(CACHE_KEY, { byPair: {}, lastFetchedAt: 0 });
  if (!a.byPair) return { byPair: {}, lastFetchedAt: 0 };
  return a;
}

/**
 * 取引所から取り直して保管庫に足す。取れなかったペアは既存のまま残す
 * (取得失敗で履歴が消えないように)。
 */
export async function refreshArchive(
  exchange: IExchange,
  pairs: string[]
): Promise<ExecutionArchive> {
  const archive = await loadArchive();
  if (!exchange.fetchExecutions) return archive;

  let changed = false;
  for (const pair of pairs) {
    try {
      const fetched = await exchange.fetchExecutions(pair);
      if (!fetched || fetched.length === 0) continue;
      const before = archive.byPair[pair]?.length ?? 0;
      archive.byPair[pair] = mergeExecutions(archive.byPair[pair] ?? [], fetched);
      if (archive.byPair[pair].length !== before) changed = true;
    } catch {
      // 取れなければ既存を残す。ここで空にすると履歴が消える
    }
  }
  if (changed) {
    archive.lastFetchedAt = Date.now();
    await saveData(CACHE_KEY, archive);
  }
  return archive;
}

/** 保管庫の全約定を1本に並べる。 */
export function flattenArchive(archive: ExecutionArchive, pairs?: string[]): ExecutionRecord[] {
  const out: ExecutionRecord[] = [];
  for (const [pair, list] of Object.entries(archive.byPair)) {
    if (pairs && !pairs.includes(pair)) continue;
    out.push(...list);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
