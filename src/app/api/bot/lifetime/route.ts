import { NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";
import type { ExecutionRecord } from "@/lib/exchanges/types";
import { computeLifetimePnL } from "@/lib/trading/lifetime";
import { loadData, saveData } from "@/lib/data";

const PAIRS = ["BTC/JPY", "ETH/JPY", "XRP/JPY"];
const CACHE_KEY = "bitflyer-executions";

interface CachedExecutions {
  byPair: Record<string, ExecutionRecord[]>;
  lastFetchedAt: number;
}

async function loadCache(): Promise<CachedExecutions> {
  return loadData<CachedExecutions>(CACHE_KEY, { byPair: {}, lastFetchedAt: 0 });
}

async function saveCache(cache: CachedExecutions): Promise<void> {
  await saveData(CACHE_KEY, cache);
}

function dedupeAndSort(records: ExecutionRecord[]): ExecutionRecord[] {
  const map = new Map<string, ExecutionRecord>();
  for (const r of records) map.set(r.id, r);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "1";

  try {
    const cache = await loadCache();
    const now = Date.now();
    // 12時間以内ならキャッシュを再利用
    const STALE_MS = 12 * 60 * 60 * 1000;
    const isStale = now - cache.lastFetchedAt > STALE_MS;
    const shouldFetch = force || isStale || Object.keys(cache.byPair).length === 0;

    let fetchedNow = false;
    if (shouldFetch) {
      const exchange = getExchange();
      if (!exchange.fetchExecutions) {
        return NextResponse.json(
          { error: "現在の取引所はfetchExecutions未対応" },
          { status: 501 }
        );
      }
      await exchange.connect();
      for (const pair of PAIRS) {
        const existing = cache.byPair[pair] ?? [];
        const lastTs = existing.length > 0 ? Math.max(...existing.map((e) => e.timestamp)) : 0;
        try {
          const fresh = await exchange.fetchExecutions(pair, lastTs > 0 ? lastTs - 1 : undefined);
          cache.byPair[pair] = dedupeAndSort([...existing, ...fresh]);
          fetchedNow = true;
        } catch (e) {
          console.error(`[lifetime] ${pair} fetch失敗:`, e);
          // 既存キャッシュは残す
        }
      }
      cache.lastFetchedAt = now;
      await saveCache(cache);
    }

    const all: ExecutionRecord[] = [];
    for (const pair of Object.keys(cache.byPair)) {
      all.push(...cache.byPair[pair]);
    }
    const summary = computeLifetimePnL(all);

    return NextResponse.json({
      summary,
      cachedAt: new Date(cache.lastFetchedAt).toISOString(),
      fetchedNow,
      pairs: PAIRS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
