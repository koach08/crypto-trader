/**
 * Kelly Criterion: 最適 bet size 計算.
 *
 * f* = (P × b - Q) / b
 *   P = 勝率
 *   Q = 負率 = 1 - P
 *   b = 勝利時オッズ = avgWin / avgLoss
 *
 * f* が最適 bet 比率 (元金の何 % を bet)
 * Edge negative なら f* < 0 → bet するな
 */

import type { TradeRecord } from "../types";

export interface KellyResult {
  /** Kelly 最適 bet 比率 (0-1) */
  kellyFraction: number;
  /** Fractional Kelly (実用的に半分にする: 1/2 Kelly) */
  fractionalKelly: number;
  /** 推奨 bet 額 (¥) */
  recommendedBetJPY: number;
  /** 勝率 */
  winRate: number;
  /** オッズ (avgWin/avgLoss) */
  odds: number;
  /** edge の存在 */
  hasEdge: boolean;
  /** 説明 */
  reasoning: string;
}

export function calculateKelly(
  trades: TradeRecord[],
  currentCapitalJPY: number,
  fractionalRatio = 0.5, // 半 Kelly (リスク管理)
): KellyResult {
  const closed = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  if (closed.length < 5) {
    return {
      kellyFraction: 0,
      fractionalKelly: 0,
      recommendedBetJPY: 0,
      winRate: 0,
      odds: 0,
      hasEdge: false,
      reasoning: `サンプル不足 (${closed.length}件)、Kelly 適用不可`,
    };
  }

  const wins = closed.filter(t => (t.pnl ?? 0) > 0);
  const losses = closed.filter(t => (t.pnl ?? 0) < 0);

  const winRate = wins.length / closed.length;
  const lossRate = 1 - winRate;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length)
    : 0;

  if (avgLoss === 0) {
    return {
      kellyFraction: 0,
      fractionalKelly: 0,
      recommendedBetJPY: 0,
      winRate,
      odds: Infinity,
      hasEdge: true,
      reasoning: "負け 0 件 (サンプル偏り)、Kelly 計算不可",
    };
  }

  const odds = avgWin / avgLoss;
  const kelly = (winRate * odds - lossRate) / odds;
  const hasEdge = kelly > 0;
  const fractionalKelly = hasEdge ? kelly * fractionalRatio : 0;
  const recommendedBetJPY = Math.round(currentCapitalJPY * fractionalKelly);

  let reasoning = "";
  if (!hasEdge) {
    reasoning = `Kelly negative (${kelly.toFixed(3)}) = bet しない事が最適 (期待値マイナス)`;
  } else if (kelly > 0.25) {
    reasoning = `Kelly 高 (${(kelly * 100).toFixed(1)}%) — 強い edge、ただし fractional で ${(fractionalKelly * 100).toFixed(1)}% に抑制`;
  } else {
    reasoning = `Kelly ${(kelly * 100).toFixed(1)}% → fractional ${(fractionalKelly * 100).toFixed(1)}% を推奨`;
  }

  return {
    kellyFraction: Math.round(kelly * 10000) / 10000,
    fractionalKelly: Math.round(fractionalKelly * 10000) / 10000,
    recommendedBetJPY,
    winRate: Math.round(winRate * 1000) / 1000,
    odds: Math.round(odds * 100) / 100,
    hasEdge,
    reasoning,
  };
}
