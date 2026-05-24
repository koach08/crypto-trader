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
  /** unix sec (number) or ISO (string) */
  added: number | string;
  channel_count: number;
  total_capacity: number;
  /** node_count は API には無い. tor + clearnet + unannounced + clearnet_tor の合算 */
  node_count?: number;
  tor_nodes?: number;
  clearnet_nodes?: number;
  unannounced_nodes?: number;
  clearnet_tor_nodes?: number;
}

function totalNodes(s: LnStat): number {
  if (typeof s.node_count === "number" && s.node_count > 0) return s.node_count;
  return (s.tor_nodes ?? 0) + (s.clearnet_nodes ?? 0) + (s.unannounced_nodes ?? 0) + (s.clearnet_tor_nodes ?? 0);
}

async function fetchJson<T>(url: string): Promise<{ data: T | null; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "crypto-trader/1.0" },
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
      nodeChangePercent7d: 0,
      channelChangePercent7d: 0,
      capacityChangePercent7d: 0,
    },
    details: ["mempool.space LN 取得失敗"],
  };

  // 直近 統計 (history 配列、最新が先頭)
  const { data: history, error } = await fetchJson<LnStat[]>(`${MEMPOOL_LN}/statistics/3m`);
  if (!history || !Array.isArray(history) || history.length === 0) {
    if (error) console.warn(`[lightning] fetch 失敗: ${error}`);
    return { ...unavailable, details: [`mempool.space LN 取得失敗 (${error ?? "no-data"})`] };
  }

  // 最新 + 7d 前を取り出す (日次データ仮定)
  const latest = history[0];
  const weekAgoIdx = Math.min(history.length - 1, 7);
  const weekAgo = history[weekAgoIdx];

  const pct = (now: number, then: number) => then > 0 ? ((now - then) / then) * 100 : 0;
  const latestNodes = totalNodes(latest);
  const weekAgoNodes = totalNodes(weekAgo);
  const nodeChange = pct(latestNodes, weekAgoNodes);
  const channelChange = pct(latest.channel_count, weekAgo.channel_count);
  const capacityChange = pct(latest.total_capacity, weekAgo.total_capacity);

  // 3 指標の平均 (capacity 重め)
  const composite = (nodeChange + channelChange + capacityChange * 2) / 4;
  let score = Math.max(-50, Math.min(50, composite * 20)); // ±2.5% → ±50pt
  if (composite >= 5) score = Math.min(80, score + 20);
  if (composite <= -5) score = Math.max(-80, score - 20);

  const details: string[] = [];
  details.push(`ノード ${latestNodes.toLocaleString()} (${nodeChange.toFixed(2)}% / 7d)`);
  details.push(`チャネル ${latest.channel_count.toLocaleString()} (${channelChange.toFixed(2)}% / 7d)`);
  details.push(`総 capacity ${(latest.total_capacity / 1e8).toFixed(0)} BTC (${capacityChange.toFixed(2)}% / 7d)`);

  return {
    score: Math.round(score),
    available: true,
    metrics: {
      nodeCount: latestNodes,
      channelCount: latest.channel_count,
      totalCapacitySat: latest.total_capacity,
      nodeChangePercent7d: nodeChange,
      channelChangePercent7d: channelChange,
      capacityChangePercent7d: capacityChange,
    },
    details,
  };
}
