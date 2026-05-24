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

export async function getStablecoinSignal(): Promise<StablecoinSignal> {
  const unavailable: StablecoinSignal = {
    score: 0,
    available: false,
    metrics: { ...ZERO },
    details: ["DeFiLlama stablecoins 取得失敗"],
  };

  // 現在の supply (上位 stablecoin)
  const list = await fetchJson<DLStablecoinList>(`${STABLECOINS_BASE}/stablecoins?includePrices=false`);
  if (!list || !Array.isArray(list.peggedAssets)) return unavailable;

  const usdtAndUsdc = list.peggedAssets.filter(p => p.symbol === "USDT" || p.symbol === "USDC");
  const breakdown = usdtAndUsdc.map(p => ({
    symbol: p.symbol,
    supplyUSD: p.circulating?.peggedUSD ?? 0,
  }));
  const currentSupplyUSD = breakdown.reduce((s, b) => s + b.supplyUSD, 0);

  // 時系列 chart で 7d 前を取る
  const chart = await fetchJson<DLChartPoint[]>(`${STABLECOINS_BASE}/stablecoincharts/all`);
  if (!chart || chart.length < 8) {
    return {
      score: 0,
      available: false,
      metrics: { currentSupplyUSD, weekAgoSupplyUSD: 0, changePercent7d: 0, breakdown },
      details: [`現在供給 $${(currentSupplyUSD / 1e9).toFixed(1)}B (時系列未取得)`],
    };
  }

  // chart は日次. 末尾が最新, 7 つ前が 7d 前
  const latest = chart[chart.length - 1];
  const weekAgo = chart[chart.length - 8];
  const latestUSD = latest?.totalCirculatingUSD?.peggedUSD ?? 0;
  const weekAgoUSD = weekAgo?.totalCirculatingUSD?.peggedUSD ?? 0;

  // 全 stablecoin の 7d change を使う (USDT+USDC が大半なので近似で OK)
  const changePercent7d = weekAgoUSD > 0 ? ((latestUSD - weekAgoUSD) / weekAgoUSD) * 100 : 0;

  // スコア: ±1% → ±40pt 線形 (それ以上は clamp)
  let score = Math.max(-40, Math.min(40, changePercent7d * 40));
  // 超急増 (+2% 以上) はさらに加点
  if (changePercent7d >= 2) score = Math.min(60, score + 20);
  if (changePercent7d <= -2) score = Math.max(-60, score - 20);

  const details: string[] = [];
  details.push(`全 stablecoin 7d 変化 ${changePercent7d.toFixed(2)}% ($${(latestUSD / 1e9).toFixed(1)}B → 1週前 $${(weekAgoUSD / 1e9).toFixed(1)}B)`);
  for (const b of breakdown) {
    details.push(`${b.symbol}: $${(b.supplyUSD / 1e9).toFixed(1)}B`);
  }

  return {
    score: Math.round(score),
    available: true,
    metrics: { currentSupplyUSD, weekAgoSupplyUSD: weekAgoUSD, changePercent7d, breakdown },
    details,
  };
}
