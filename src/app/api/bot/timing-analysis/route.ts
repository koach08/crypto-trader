import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";
import { detectRegime } from "@/lib/indicators";
import type { OHLCVBar, TradeRecord } from "@/lib/types";

const COINGECKO_IDS: Record<string, string> = {
  "BTC/JPY": "bitcoin",
  "ETH/JPY": "ethereum",
  "XRP/JPY": "ripple",
};

interface FngEntry {
  value: number;
  classification: string;
  timestamp: number;
  date: string;
}

async function fetchFng(days: number): Promise<FngEntry[]> {
  try {
    const r = await fetch(`https://api.alternative.me/fng/?limit=${days}`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 3600 },
    });
    if (!r.ok) return [];
    const json = await r.json();
    return ((json.data ?? []) as Array<{ value: string; value_classification: string; timestamp: string }>)
      .map((d) => {
        const ts = Number(d.timestamp) * 1000;
        return {
          value: Number(d.value),
          classification: d.value_classification,
          timestamp: ts,
          date: new Date(ts).toISOString().split("T")[0],
        };
      })
      .reverse(); // 古い順
  } catch {
    return [];
  }
}

async function fetchCoingeckoDaily(coinId: string, days: number): Promise<OHLCVBar[]> {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=jpy&days=${days}&interval=daily`,
      { signal: AbortSignal.timeout(10000), next: { revalidate: 3600 } }
    );
    if (!r.ok) return [];
    const json = await r.json();
    const prices: [number, number][] = json.prices ?? [];
    return prices.map(([ts, price]) => ({
      timestamp: ts,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    }));
  } catch {
    return [];
  }
}

function pctChange(arr: OHLCVBar[]): number {
  if (arr.length < 2) return 0;
  return ((arr[arr.length - 1].close - arr[0].close) / arr[0].close) * 100;
}

function computeRegimePerDay(bars: OHLCVBar[]): Record<string, number> {
  const counts: Record<string, number> = {
    TRENDING_UP: 0,
    TRENDING_DOWN: 0,
    RANGING: 0,
    VOLATILE: 0,
  };
  // SMA 計算には十分な過去が要るので最後20日分だけ判定
  const startIdx = Math.max(50, bars.length - 20);
  for (let i = startIdx; i < bars.length; i++) {
    const window = bars.slice(0, i + 1);
    const r = detectRegime(window);
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

export async function GET() {
  const days = 30;

  // 1. F&G 履歴
  const fng = await fetchFng(days);
  const fngExtreme = fng.filter((f) => f.value <= 30 || f.value >= 70).length;
  const fngFear = fng.filter((f) => f.value <= 30).length;
  const fngGreed = fng.filter((f) => f.value >= 70).length;
  const fngAvg = fng.length > 0 ? fng.reduce((s, f) => s + f.value, 0) / fng.length : 50;

  // 2. ペア毎の値動き + レジーム集計
  const pairs = Object.keys(COINGECKO_IDS);
  const perPair = await Promise.all(
    pairs.map(async (pair) => {
      const bars = await fetchCoingeckoDaily(COINGECKO_IDS[pair], days);
      const recent = bars.slice(-days);
      const change = pctChange(recent);
      const regimes = computeRegimePerDay(bars);
      return {
        pair,
        days: recent.length,
        firstClose: recent[0]?.close ?? 0,
        lastClose: recent[recent.length - 1]?.close ?? 0,
        changePercent: change,
        regimes,
      };
    })
  );

  // 3. Bot 実取引: 期間内の trade 集計
  const liveTrades = await loadData<TradeRecord[]>("live-trades", []);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const periodTrades = liveTrades.filter((t) => new Date(t.timestamp).getTime() >= cutoff);
  const buys = periodTrades.filter((t) => t.side === "buy");
  const sells = periodTrades.filter((t) => t.side === "sell");
  const realizedPnL = sells.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // 4. Buy&Hold 比較: 期間頭にBTC/ETH/XRPに均等買付した場合
  const buyHoldReturn = perPair.reduce((s, p) => s + p.changePercent, 0) / perPair.length;

  // 5. 結論ロジック
  const verdicts: string[] = [];
  if (fngExtreme < 5) {
    verdicts.push(`F&G extreme日 ${fngExtreme}/${fng.length}日 → 新戦略のエントリー機会ほぼなし。HOLD連発が正解。`);
  } else {
    verdicts.push(`F&G extreme日 ${fngExtreme}/${fng.length}日 → 一定のエントリー機会あり。`);
  }
  const trendingDownCount = perPair.reduce((s, p) => s + (p.regimes.TRENDING_DOWN ?? 0), 0);
  const trendingUpCount = perPair.reduce((s, p) => s + (p.regimes.TRENDING_UP ?? 0), 0);
  if (trendingDownCount > trendingUpCount * 1.5) {
    verdicts.push(`下降トレンド日数 ${trendingDownCount} >> 上昇 ${trendingUpCount}。買い向きの環境ではなかった。`);
  } else if (trendingUpCount > trendingDownCount * 1.5) {
    verdicts.push(`上昇トレンド日数 ${trendingUpCount} >> 下降 ${trendingDownCount}。Buy&Hold が有利な環境。`);
  } else {
    verdicts.push(`上昇/下降トレンド拮抗 (上${trendingUpCount}/下${trendingDownCount})。レンジ局面、エッジ取りにくい。`);
  }
  if (Math.abs(buyHoldReturn) < 3) {
    verdicts.push(`Buy&Hold リターン ${buyHoldReturn.toFixed(1)}% (横ばい)。短期取引で勝つには相当のエッジ必要。`);
  } else if (buyHoldReturn > 0) {
    verdicts.push(`Buy&Hold +${buyHoldReturn.toFixed(1)}%。基本ロングが勝つ局面、bot のショート/SL は損する側に出やすい。`);
  } else {
    verdicts.push(`Buy&Hold ${buyHoldReturn.toFixed(1)}%。市場が下げてる中、ロング bot は構造的に不利。`);
  }

  return NextResponse.json({
    days,
    fng: {
      avg: fngAvg,
      extremeDays: fngExtreme,
      fearDays: fngFear,
      greedDays: fngGreed,
      history: fng.slice(-14), // 直近14日だけ返す
    },
    pairs: perPair,
    botActivity: {
      totalTrades: periodTrades.length,
      buys: buys.length,
      sells: sells.length,
      realizedPnL: Math.round(realizedPnL),
    },
    buyHoldAvgReturnPercent: Number(buyHoldReturn.toFixed(2)),
    verdicts,
  });
}
