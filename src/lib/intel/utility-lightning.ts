/**
 * Lightning Network 成長 = BTC を実際に決済に使う人の規模.
 *
 * LN は BTC 小額決済の主要レイヤー. 容量とチャネル数が伸びる =
 * 「BTC で実際にコーヒー買う / 送金する」人の規模拡大.
 *
 * データ源: mempool.space LN API (https://mempool.space/api/v1/lightning/statistics/latest)
 *   - ノード数
 *   - チャネル数
 *   - 総 capacity (sat)
 *
 * スコア:
 *   capacity, channels, nodes の 7d 変化を平均し ±2% → ±40pt
 */

export interface LightningSignal {
  /** -100 〜 +100 */
  score: number;
  available: boolean;
  metrics: {
    nodeCount: number;
    channelCount: number;
    totalCapacitySat: number;
    /** 過去 7d 比較 (取得できれば) */
    nodeChangePercent7d: number;
    channelChangePercent7d: number;
    capacityChangePercent7d: number;
  };
  details: string[];
}

const MEMPOOL_LN = "https://mempool.space/api/v1/lightning";

interface LnStat {
  added: string;
  channel_count: number;
  node_count: number;
  total_capacity: number;
  tor_nodes?: number;
  clearnet_nodes?: number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
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
      nodeChangePercent7d: 0,
      channelChangePercent7d: 0,
      capacityChangePercent7d: 0,
    },
    details: ["mempool.space LN 取得失敗"],
  };

  // 直近 統計 (history 配列、最新が先頭)
  const history = await fetchJson<LnStat[]>(`${MEMPOOL_LN}/statistics/3m`);
  if (!history || !Array.isArray(history) || history.length === 0) return unavailable;

  // 最新 + 7d 前を取り出す (日次データ仮定)
  const latest = history[0];
  const weekAgoIdx = Math.min(history.length - 1, 7);
  const weekAgo = history[weekAgoIdx];

  const pct = (now: number, then: number) => then > 0 ? ((now - then) / then) * 100 : 0;
  const nodeChange = pct(latest.node_count, weekAgo.node_count);
  const channelChange = pct(latest.channel_count, weekAgo.channel_count);
  const capacityChange = pct(latest.total_capacity, weekAgo.total_capacity);

  // 3 指標の平均 (capacity 重め)
  const composite = (nodeChange + channelChange + capacityChange * 2) / 4;
  let score = Math.max(-50, Math.min(50, composite * 20)); // ±2.5% → ±50pt
  if (composite >= 5) score = Math.min(80, score + 20);
  if (composite <= -5) score = Math.max(-80, score - 20);

  const details: string[] = [];
  details.push(`ノード ${latest.node_count.toLocaleString()} (${nodeChange.toFixed(2)}% / 7d)`);
  details.push(`チャネル ${latest.channel_count.toLocaleString()} (${channelChange.toFixed(2)}% / 7d)`);
  details.push(`総 capacity ${(latest.total_capacity / 1e8).toFixed(0)} BTC (${capacityChange.toFixed(2)}% / 7d)`);

  return {
    score: Math.round(score),
    available: true,
    metrics: {
      nodeCount: latest.node_count,
      channelCount: latest.channel_count,
      totalCapacitySat: latest.total_capacity,
      nodeChangePercent7d: nodeChange,
      channelChangePercent7d: channelChange,
      capacityChangePercent7d: capacityChange,
    },
    details,
  };
}
