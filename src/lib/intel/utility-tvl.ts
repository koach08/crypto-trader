/**
 * DeFi TVL = ETH/USDC が利回り運用に「使われてる」総額.
 * crypto エコシステム健全度の代表指標.
 *
 * データ源: DeFiLlama (https://api.llama.fi/v2/historicalChainTvl)
 *
 * スコア:
 *   7d TVL 変化 ±5% → ±40pt
 */

export interface TvlSignal {
  score: number;
  available: boolean;
  metrics: {
    currentTvlUSD: number;
    weekAgoTvlUSD: number;
    changePercent7d: number;
  };
  details: string[];
}

const DL_HIST_TVL = "https://api.llama.fi/v2/historicalChainTvl";

interface HistTvlPoint { date: number; tvl: number }

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getTvlSignal(): Promise<TvlSignal> {
  const unavailable: TvlSignal = {
    score: 0,
    available: false,
    metrics: { currentTvlUSD: 0, weekAgoTvlUSD: 0, changePercent7d: 0 },
    details: ["DeFiLlama TVL 取得失敗"],
  };
  const series = await fetchJson<HistTvlPoint[]>(DL_HIST_TVL);
  if (!series || !Array.isArray(series) || series.length < 8) return unavailable;
  const last = series[series.length - 1];
  const wago = series[series.length - 8];
  const change = wago?.tvl > 0 ? ((last.tvl - wago.tvl) / wago.tvl) * 100 : 0;

  // ±5% で ±40, それ以上は加速
  let score = Math.max(-40, Math.min(40, change * 8));
  if (change >= 10) score = Math.min(60, score + 20);
  if (change <= -10) score = Math.max(-60, score - 20);

  return {
    score: Math.round(score),
    available: true,
    metrics: {
      currentTvlUSD: last.tvl,
      weekAgoTvlUSD: wago.tvl,
      changePercent7d: change,
    },
    details: [`DeFi TVL 7d ${change.toFixed(2)}% ($${(last.tvl / 1e9).toFixed(1)}B → 1週前 $${(wago.tvl / 1e9).toFixed(1)}B)`],
  };
}
