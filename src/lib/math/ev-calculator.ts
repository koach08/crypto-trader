/**
 * 期待値 (Expected Value) 計算.
 * 過去取引データから、当該シグナル/regime での EV を出す.
 */

import type { TradeRecord } from "../types";

export interface EVResult {
  /** 期待値 (¥/取引) */
  expectedValue: number;
  /** 勝率 (0-1) */
  winRate: number;
  /** 平均勝ち額 */
  avgWin: number;
  /** 平均負け額 */
  avgLoss: number;
  /** 想定手数料 (往復) */
  fees: number;
  /** EV > 0 で fire 推奨 */
  shouldFire: boolean;
  /** サンプル数 */
  sampleSize: number;
  /** 信頼度 (サンプル数による) */
  confidence: "high" | "medium" | "low";
}

/**
 * 過去取引から EV を計算.
 *
 * @param trades 過去の決済取引
 * @param feesPerTrade 1取引あたり手数料 (maker なら 0、taker なら 0.30%)
 * @param tradeSizeJPY 想定取引額
 */
export function calculateEV(
  trades: TradeRecord[],
  feesPerTrade = 0,
  tradeSizeJPY = 30000,
): EVResult {
  const closed = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  const sampleSize = closed.length;

  if (sampleSize === 0) {
    return {
      expectedValue: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      fees: 0,
      shouldFire: false,
      sampleSize: 0,
      confidence: "low",
    };
  }

  const wins = closed.filter(t => (t.pnl ?? 0) > 0);
  const losses = closed.filter(t => (t.pnl ?? 0) < 0);

  const winRate = wins.length / sampleSize;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length)
    : 0;

  // EV = P(W) × avgWin + P(L) × (-avgLoss) - fees
  const fees = feesPerTrade * tradeSizeJPY;
  const ev = winRate * avgWin - (1 - winRate) * avgLoss - fees;

  const confidence: EVResult["confidence"] =
    sampleSize >= 100 ? "high" :
    sampleSize >= 30 ? "medium" :
    "low";

  return {
    expectedValue: Math.round(ev * 100) / 100,
    winRate: Math.round(winRate * 1000) / 1000,
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    fees: Math.round(fees * 100) / 100,
    shouldFire: ev > 0,
    sampleSize,
    confidence,
  };
}

/** 特定 regime/pair でフィルタして EV 計算 */
export function calculateEVByCondition(
  trades: TradeRecord[],
  filter: (t: TradeRecord) => boolean,
  feesPerTrade = 0,
  tradeSizeJPY = 30000,
): EVResult {
  return calculateEV(trades.filter(filter), feesPerTrade, tradeSizeJPY);
}
