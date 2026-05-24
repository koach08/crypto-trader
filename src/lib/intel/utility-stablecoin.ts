/**
 * Stablecoin 供給量 = 流入予兆 + 実需 proxy.
 *
 * USDT/USDC の総供給が伸びてる = 新規 fiat が crypto エコシステムに入ってくる
 * = 買い圧力源.
 *
 * データ源: DeFiLlama stablecoins (https://stablecoins.llama.fi)
 *   - GET /stablecoins?includePrices=false : 全 stablecoin の現在総供給
 *   - GET /stablecoincharts/all : 全 stablecoin の時系列 supply
 *
 * スコア:
 *   USDT+USDC 合計が直近 7d で +1% 以上 → bullish (+40)
 *   -1% 以下 → bearish (-40)
 *   横ばい → 0
 */

export interface StablecoinSignal {
  /** -100 (供給急減) 〜 +100 (供給急増) */
  score: number;
  available: boolean;
  metrics: {
    currentSupplyUSD: number;
    weekAgoSupplyUSD: number;
    changePercent7d: number;
    breakdown: Array<{ symbol: string; supplyUSD: number }>;
  };
  details: string[];
}

const STABLECOINS_BASE = "https://stablecoins.llama.fi";

interface DLStablecoinList {
  peggedAssets: Array<{
    id: string;
    name: string;
    symbol: string;
    circulating: { peggedUSD?: number };
    chainCirculating?: Record<string, { current: { peggedUSD?: number } }>;
  }>;
}

interface DLChartPoint {
  date: string; // unix seconds as string
  totalCirculatingUSD: { peggedUSD?: number };
}

const ZERO: StablecoinSignal["metrics"] = {
  currentSupplyUSD: 0,
  weekAgoSupplyUSD: 0,
  changePercent7d: 0,
  breakdown: [],
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * outlier 検知: 前後値と比べて > ±30% 急変してる点は壊れデータと判定.
 * DeFiLlama の chart 最新点が時々データ取得タイミングで半減することがある.
 */
function findStableLatestIndex(chart: DLChartPoint[]): number {
  if (chart.length < 3) return chart.length - 1;
  // 末尾から遡って「前 2 日と比べて ±30% 以内」の点を最新採用
  for (let i = chart.length - 1; i >= 2; i--) {
    const v = chart[i]?.totalCirculatingUSD?.peggedUSD ?? 0;
    const prev1 = chart[i - 1]?.totalCirculatingUSD?.peggedUSD ?? 0;
    const prev2 = chart[i - 2]?.totalCirculatingUSD?.peggedUSD ?? 0;
    if (v <= 0 || prev1 <= 0 || prev2 <= 0) continue;
    const avgPrev = (prev1 + prev2) / 2;
    const deviation = Math.abs(v - avgPrev) / avgPrev;
    if (deviation <= 0.30) return i; // 30% 以内なら採用
  }
  return chart.length - 1; // すべて outlier に見えたら末尾を返す (緊急 fallback)
}

export async function getStablecoinSignal(): Promise<StablecoinSignal> {
  const unavailable: StablecoinSignal = {
    score: 0,
    available: false,
    metrics: { ...ZERO },
    details: ["DeFiLlama stablecoins 取得失敗"],
  };

  // 現在の supply 全 stablecoin 合計 (chart と同じスケールで比較するため全件合計)
  const list = await fetchJson<DLStablecoinList>(`${STABLECOINS_BASE}/stablecoins?includePrices=false`);
  if (!list || !Array.isArray(list.peggedAssets)) return unavailable;

  const totalCurrentUSD = list.peggedAssets.reduce(
    (s, p) => s + (p.circulating?.peggedUSD ?? 0),
    0
  );

  // breakdown は USDT/USDC のみ (UI 表示用)
  const usdtAndUsdc = list.peggedAssets.filter(p => p.symbol === "USDT" || p.symbol === "USDC");
  const breakdown = usdtAndUsdc.map(p => ({
    symbol: p.symbol,
    supplyUSD: p.circulating?.peggedUSD ?? 0,
  }));

  // 時系列 chart で「7d 前の値だけ」を信頼度高い点から取る
  const chart = await fetchJson<DLChartPoint[]>(`${STABLECOINS_BASE}/stablecoincharts/all`);
  if (!chart || chart.length < 10) {
    return {
      score: 0,
      available: false,
      metrics: { currentSupplyUSD: totalCurrentUSD, weekAgoSupplyUSD: 0, changePercent7d: 0, breakdown },
      details: [`現在供給 $${(totalCurrentUSD / 1e9).toFixed(1)}B (時系列未取得)`],
    };
  }

  // 末尾の壊れデータをスキップして「直近の安定した点」を見つける
  const stableLatestIdx = findStableLatestIndex(chart);
  // その 7 日前
  const weekAgoIdx = Math.max(0, stableLatestIdx - 7);
  const weekAgoUSD = chart[weekAgoIdx]?.totalCirculatingUSD?.peggedUSD ?? 0;

  // 比較: 現在 (list API の合計) vs 1 週前 (chart)
  // どちらも「全 stablecoin USD 換算合計」なので scale 一致
  const changePercent7d = weekAgoUSD > 0
    ? ((totalCurrentUSD - weekAgoUSD) / weekAgoUSD) * 100
    : 0;

  // 異常値ガード: ±20% を超える変化は DeFiLlama データ不整合の可能性高い → 0 扱い
  if (Math.abs(changePercent7d) > 20) {
    return {
      score: 0,
      available: false,
      metrics: { currentSupplyUSD: totalCurrentUSD, weekAgoSupplyUSD: weekAgoUSD, changePercent7d, breakdown },
      details: [`異常値検知 7d ${changePercent7d.toFixed(1)}% (DeFiLlama データ不整合の可能性)`],
    };
  }

  // スコア: ±1% → ±40pt 線形, ±2% 以上は加速
  let score = Math.max(-40, Math.min(40, changePercent7d * 40));
  if (changePercent7d >= 2) score = Math.min(60, score + 20);
  if (changePercent7d <= -2) score = Math.max(-60, score - 20);

  const details: string[] = [];
  details.push(`全 stablecoin 7d 変化 ${changePercent7d.toFixed(2)}% ($${(totalCurrentUSD / 1e9).toFixed(1)}B → 1週前 $${(weekAgoUSD / 1e9).toFixed(1)}B)`);
  for (const b of breakdown) {
    details.push(`${b.symbol}: $${(b.supplyUSD / 1e9).toFixed(1)}B`);
  }

  return {
    score: Math.round(score),
    available: true,
    metrics: { currentSupplyUSD: totalCurrentUSD, weekAgoSupplyUSD: weekAgoUSD, changePercent7d, breakdown },
    details,
  };
}
