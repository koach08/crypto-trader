/**
 * Lightning Network 成長 = BTC を実際に決済に使う人の規模.
 *
 * 旧 mempool.space LN は 2026-02-15 で集計停止 (statistics/3m が [] を返す).
 * 1ml.com の statistics?json=true に切替.
 *
 * 1ml.com の利点:
 *   - 30d change フィールドが built-in (numberofnodes30dchange など)
 *   - newnodes24h, newchannels24h で「直近の伸び」も取れる
 *   - USD 換算 capacity も持ってる
 *
 * スコア化:
 *   30d change を 4 で割って ~7d 換算
 *   ノード/チャネル/容量の重み付き平均
 *   newnodes24h が異常に多ければ追加 boost
 */

export interface LightningSignal {
  score: number;
  available: boolean;
  metrics: {
    nodeCount: number;
    channelCount: number;
    totalCapacitySat: number;
    totalCapacityUSD: number;
    nodeChangePercent7d: number;
    channelChangePercent7d: number;
    capacityChangePercent7d: number;
    newNodes24h: number;
    newChannels24h: number;
  };
  details: string[];
  errors?: string[];
}

const ONEML_STATS = "https://1ml.com/statistics?json=true";

interface OneMlStats {
  numberofnodes: number;
  numberofnodes30dchange?: number;
  numberofchannels: number;
  numberofchannels30dchange?: number;
  networkcapacity: number; // sat
  networkcapacity30dchange?: number;
  networkcapacityusd?: number;
  newnodes24h?: number;
  newchannels24h?: number;
}

async function fetchJson<T>(url: string): Promise<{ data: T | null; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        // 1ml.com は generic UA を block 気味なのでブラウザ風 UA
        "User-Agent": "Mozilla/5.0 (compatible; crypto-trader/1.0)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { data: null, error: `http-${res.status}` };
    return { data: (await res.json()) as T };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message.slice(0, 100) : "fetch failed" };
  }
}

export async function getLightningSignal(): Promise<LightningSignal> {
  const unavailable: LightningSignal = {
    score: 0,
    available: false,
    metrics: {
      nodeCount: 0,
      channelCount: 0,
      totalCapacitySat: 0,
      totalCapacityUSD: 0,
      nodeChangePercent7d: 0,
      channelChangePercent7d: 0,
      capacityChangePercent7d: 0,
      newNodes24h: 0,
      newChannels24h: 0,
    },
    details: ["1ml.com 取得失敗"],
  };

  const { data, error } = await fetchJson<OneMlStats>(ONEML_STATS);
  if (!data) {
    if (error) console.warn(`[lightning] 1ml.com fetch 失敗: ${error}`);
    return { ...unavailable, details: [`1ml.com 取得失敗 (${error ?? "no-data"})`], errors: error ? [error] : undefined };
  }

  // 30d change を 7d 相当に按分 (30d 中の純変化を 7d/30d で線形近似)
  const node30d = data.numberofnodes30dchange ?? 0;
  const chan30d = data.numberofchannels30dchange ?? 0;
  const cap30d = data.networkcapacity30dchange ?? 0;
  const nodeChange = (node30d * 7) / 30;
  const channelChange = (chan30d * 7) / 30;
  const capacityChange = (cap30d * 7) / 30;

  // 重み: capacity > nodes > channels (capacity = 実際にロックされてる BTC = 重み大)
  const composite = (nodeChange * 0.25) + (channelChange * 0.20) + (capacityChange * 0.55);
  let score = Math.max(-50, Math.min(50, composite * 25)); // ±2% → ±50pt
  if (composite >= 5) score = Math.min(80, score + 20);
  if (composite <= -5) score = Math.max(-80, score - 20);

  // newnodes24h boost: 直近 24h で異常に活発なら追加
  const newNodes = data.newnodes24h ?? 0;
  if (newNodes >= 100) score = Math.min(100, score + 10);

  const details: string[] = [];
  details.push(`ノード ${data.numberofnodes.toLocaleString()} (30d ${node30d.toFixed(2)}% → 7d換算 ${nodeChange.toFixed(2)}%)`);
  details.push(`チャネル ${data.numberofchannels.toLocaleString()} (30d ${chan30d.toFixed(2)}%)`);
  details.push(`総 capacity ${(data.networkcapacity / 1e8).toFixed(0)} BTC (30d ${cap30d.toFixed(2)}%)`);
  if (newNodes > 0) details.push(`新規ノード 24h: ${newNodes}`);

  return {
    score: Math.round(score),
    available: true,
    metrics: {
      nodeCount: data.numberofnodes,
      channelCount: data.numberofchannels,
      totalCapacitySat: data.networkcapacity,
      totalCapacityUSD: data.networkcapacityusd ?? 0,
      nodeChangePercent7d: nodeChange,
      channelChangePercent7d: channelChange,
      capacityChangePercent7d: capacityChange,
      newNodes24h: newNodes,
      newChannels24h: data.newchannels24h ?? 0,
    },
    details,
  };
}
