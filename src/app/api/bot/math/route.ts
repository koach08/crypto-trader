import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";
import { calculateEV } from "@/lib/math/ev-calculator";
import { estimateBayesianEdge } from "@/lib/math/bayesian-edge";
import { runMonteCarlo } from "@/lib/math/monte-carlo";
import { calculateKelly } from "@/lib/math/kelly";
import type { TradeRecord } from "@/lib/types";

/**
 * 数学的 bot 評価.
 * 過去取引データから EV / Bayesian edge / Monte Carlo / Kelly を全部計算して返す.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const futureTrades = Number(url.searchParams.get("future") ?? "100");
  const iterations = Number(url.searchParams.get("iter") ?? "10000");
  const capital = Number(url.searchParams.get("capital") ?? "50000");
  const pair = url.searchParams.get("pair");

  const trades = await loadData<TradeRecord[]>("live-trades", []);
  const filtered = pair ? trades.filter(t => t.pair === pair) : trades;

  // maker-only 想定で fees = 0 (実際は約定状況による)
  const ev = calculateEV(filtered, 0, 30000);
  const bayesian = estimateBayesianEdge(filtered);
  const monteCarlo = runMonteCarlo(filtered, futureTrades, iterations, capital);
  const kelly = calculateKelly(filtered, capital);

  // ペア別 EV も計算
  const byPair: Record<string, ReturnType<typeof calculateEV>> = {};
  const pairs = [...new Set(filtered.map(t => t.pair))];
  for (const p of pairs) {
    byPair[p] = calculateEV(filtered.filter(t => t.pair === p), 0, 30000);
  }

  return NextResponse.json({
    ev,
    bayesian,
    monteCarlo,
    kelly,
    byPair,
    inputs: { sampleSize: filtered.length, pair, capital, futureTrades, iterations },
    interpretation: {
      hasEdge: bayesian.edgeProbability > 0.6,
      shouldTrade: ev.expectedValue > 0,
      optimalSize: kelly.recommendedBetJPY,
      futureOutlook: monteCarlo.median >= 0 ? "中央値プラス" : `中央値 ¥${monteCarlo.median.toLocaleString()} (赤字傾向)`,
      bankruptcyRisk: `${(monteCarlo.bankruptcyProbability * 100).toFixed(1)}%`,
    },
  });
}
