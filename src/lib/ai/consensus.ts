import type { EngineResult, CryptoAction, AIDecision, EngineId, RiskLevel } from "../types";
import { ENGINE_CONFIG } from "../types";

export function buildConsensus(
  results: EngineResult[],
  pair: string,
  exchange: string,
  technicalScore: number,
  fearGreedIndex: number,
  paperMode = false
): AIDecision {
  const successful = results.filter(r => r.status === "success" && r.action);

  if (successful.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      pair,
      exchange,
      action: "HOLD",
      confidence: 0,
      reason: "全AIエンジンがエラー",
      riskLevel: "HIGH",
      suggestedStopLossPercent: 2.0,
      suggestedTakeProfitPercent: 3.0,
      technicalScore,
      fearGreedIndex,
      engineResults: results,
    };
  }

  // Weighted vote
  const votes: Record<CryptoAction, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  let totalWeight = 0;
  let weightedConfidence = 0;

  for (const r of successful) {
    const weight = ENGINE_CONFIG[r.engine as EngineId]?.weight ?? 0.8;
    votes[r.action!] += weight;
    weightedConfidence += (r.confidence ?? 0) * weight;
    totalWeight += weight;
  }

  const avgConfidence = totalWeight > 0 ? Math.round(weightedConfidence / totalWeight) : 0;

  // Find winning action
  let winningAction: CryptoAction = "HOLD";
  let maxVote = 0;
  for (const [action, vote] of Object.entries(votes) as [CryptoAction, number][]) {
    if (vote > maxVote) {
      maxVote = vote;
      winningAction = action;
    }
  }

  // If confidence is too low, force HOLD (paper mode uses lower threshold)
  const minConfidence = paperMode ? 40 : 60;
  if (avgConfidence < minConfidence && winningAction !== "HOLD") {
    winningAction = "HOLD";
  }

  // Build reason
  const actionCounts = successful.reduce((acc, r) => {
    acc[r.action!] = (acc[r.action!] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const reason = successful.find(r => r.action === winningAction)?.summary
    ?? `${successful.length}エンジン中 ${JSON.stringify(actionCounts)}`;

  // Risk level from average
  const riskLevels = successful
    .map(r => r.suggestedStopLoss ?? 2.0);
  const avgStopLoss = riskLevels.reduce((a, b) => a + b, 0) / riskLevels.length;
  const riskLevel: RiskLevel = avgStopLoss > 3 ? "HIGH" : avgStopLoss > 1.5 ? "MEDIUM" : "LOW";

  const takeProfits = successful.map(r => r.suggestedTakeProfit ?? 3.0);
  const avgTakeProfit = takeProfits.reduce((a, b) => a + b, 0) / takeProfits.length;

  return {
    timestamp: new Date().toISOString(),
    pair,
    exchange,
    action: winningAction,
    confidence: avgConfidence,
    reason,
    riskLevel,
    suggestedStopLossPercent: Math.round(avgStopLoss * 10) / 10,
    suggestedTakeProfitPercent: Math.round(avgTakeProfit * 10) / 10,
    technicalScore,
    fearGreedIndex,
    engineResults: results,
  };
}
