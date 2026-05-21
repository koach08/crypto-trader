/**
 * Monte Carlo シミュレーション.
 * 過去の勝率/勝ち負け分布から、将来 N 取引の損益分布を予測.
 */

import type { TradeRecord } from "../types";

export interface MonteCarloResult {
  /** シミュレーション後の予想最終損益 (中央値) */
  median: number;
  /** 5%ile (悪いケース) */
  p5: number;
  /** 25%ile */
  p25: number;
  /** 75%ile */
  p75: number;
  /** 95%ile (良いケース) */
  p95: number;
  /** 破産確率 (元手 X 円失う確率) */
  bankruptcyProbability: number;
  /** 元手損失なし確率 (利益ある or トントン) */
  positiveOrFlatProbability: number;
  /** シミュレーションした取引数 */
  simulatedTrades: number;
  /** 試行回数 */
  iterations: number;
}

/**
 * 過去取引から実損益分布をサンプリングして将来予測.
 *
 * @param trades 過去の決済取引
 * @param futureTrades 何取引先まで予測するか (例: 100)
 * @param iterations Monte Carlo 試行回数 (例: 10000)
 * @param initialCapital 初期資金 (破産判定用)
 */
export function runMonteCarlo(
  trades: TradeRecord[],
  futureTrades = 100,
  iterations = 10000,
  initialCapital = 50000,
): MonteCarloResult {
  const closed = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  const pnls = closed.map(t => t.pnl ?? 0);

  if (pnls.length < 5) {
    return {
      median: 0,
      p5: 0,
      p25: 0,
      p75: 0,
      p95: 0,
      bankruptcyProbability: 0,
      positiveOrFlatProbability: 0,
      simulatedTrades: 0,
      iterations: 0,
    };
  }

  const finalPnls: number[] = [];
  let bankruptcies = 0;
  let positiveOrFlat = 0;

  for (let i = 0; i < iterations; i++) {
    let capital = initialCapital;
    let cumulativePnl = 0;
    let bankrupt = false;

    for (let t = 0; t < futureTrades; t++) {
      // ランダムに過去の損益から1つサンプリング (bootstrap)
      const sample = pnls[Math.floor(Math.random() * pnls.length)];
      cumulativePnl += sample;
      capital += sample;
      if (capital <= 0) {
        bankrupt = true;
        break;
      }
    }

    if (bankrupt) bankruptcies++;
    if (cumulativePnl >= 0) positiveOrFlat++;
    finalPnls.push(cumulativePnl);
  }

  finalPnls.sort((a, b) => a - b);
  const percentile = (p: number) => finalPnls[Math.floor(finalPnls.length * p)];

  return {
    median: Math.round(percentile(0.5)),
    p5: Math.round(percentile(0.05)),
    p25: Math.round(percentile(0.25)),
    p75: Math.round(percentile(0.75)),
    p95: Math.round(percentile(0.95)),
    bankruptcyProbability: Math.round((bankruptcies / iterations) * 1000) / 1000,
    positiveOrFlatProbability: Math.round((positiveOrFlat / iterations) * 1000) / 1000,
    simulatedTrades: futureTrades,
    iterations,
  };
}
