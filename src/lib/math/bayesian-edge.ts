/**
 * Bayesian edge 推定.
 * 取引結果を順次取り込み、「真の勝率」の事後分布を更新.
 * Beta 分布 (共役事前分布) で計算.
 */

import type { TradeRecord } from "../types";

export interface BayesianEdge {
  /** 推定勝率 (事後平均) */
  estimatedWinRate: number;
  /** 95% 信頼区間 下限 */
  ciLower: number;
  /** 95% 信頼区間 上限 */
  ciUpper: number;
  /** edge があるか (勝率 > 0.5 の事後確率) */
  edgeProbability: number;
  /** サンプル数 */
  sampleSize: number;
  /** 勝ち数 */
  wins: number;
  /** 負け数 */
  losses: number;
  /** 判定文 */
  verdict: string;
}

/**
 * Beta 分布の事後パラメータから 95% CI を求める.
 * Beta(α, β) の平均 = α/(α+β)、分散 = αβ/((α+β)^2(α+β+1))
 * 正規近似で CI を求める (サンプル数が大きい時に有効)
 */
function betaConfidenceInterval(alpha: number, beta: number): { mean: number; ciLower: number; ciUpper: number } {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
  const std = Math.sqrt(variance);
  // 95% CI ≈ mean ± 1.96 × std (正規近似)
  return {
    mean,
    ciLower: Math.max(0, mean - 1.96 * std),
    ciUpper: Math.min(1, mean + 1.96 * std),
  };
}

/**
 * Beta(α, β) で 「P(X > 0.5)」 を計算 (regularized incomplete beta function 近似)
 * 簡略化: 正規近似で計算
 */
function probabilityWinRateAbove(alpha: number, beta: number, threshold: number): number {
  const { mean, ciLower, ciUpper } = betaConfidenceInterval(alpha, beta);
  const std = (ciUpper - ciLower) / (2 * 1.96);
  if (std === 0) return mean > threshold ? 1 : 0;
  // P(X > threshold) for normal distribution
  const z = (mean - threshold) / std;
  // standard normal CDF approximation
  return 1 - normalCdf(z);
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * 取引履歴から Bayesian edge 推定.
 * 事前分布: Beta(1, 1) (uniform、無情報)
 * 各勝ちで α+1、各負けで β+1
 */
export function estimateBayesianEdge(trades: TradeRecord[]): BayesianEdge {
  const closed = trades.filter(t => t.side === "sell" && t.pnl !== undefined);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter(t => (t.pnl ?? 0) < 0).length;

  // 事前 Beta(1, 1) + 観測 → 事後 Beta(1+wins, 1+losses)
  const alpha = 1 + wins;
  const beta = 1 + losses;
  const { mean, ciLower, ciUpper } = betaConfidenceInterval(alpha, beta);
  const edgeProb = probabilityWinRateAbove(alpha, beta, 0.5);

  let verdict = "";
  if (edgeProb > 0.9) verdict = "強い edge (勝率 > 50% 高確率)";
  else if (edgeProb > 0.7) verdict = "edge あり (勝率 > 50% 可能性高)";
  else if (edgeProb > 0.5) verdict = "edge 不明 (50/50)";
  else if (edgeProb > 0.3) verdict = "edge negative の可能性";
  else verdict = "edge negative (勝率 < 50% 高確率)";

  return {
    estimatedWinRate: Math.round(mean * 1000) / 1000,
    ciLower: Math.round(ciLower * 1000) / 1000,
    ciUpper: Math.round(ciUpper * 1000) / 1000,
    edgeProbability: Math.round(edgeProb * 1000) / 1000,
    sampleSize: closed.length,
    wins,
    losses,
    verdict,
  };
}
