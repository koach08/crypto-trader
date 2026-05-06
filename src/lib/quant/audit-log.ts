/**
 * 取引判断の監査ログ
 * 全ての判断根拠をトレース可能に記録する
 *
 * 目的：
 * - なぜその判断に至ったかを後から検証できる
 * - 失敗した取引の原因を特定できる
 * - 改善ループ（Phase 2）のデータ基盤
 */

import { saveData, loadData } from "../data";
import type { QuantAnalysis } from "./signals";
import type { AIDecision, CryptoAction } from "../types";
import type { MarketRegime } from "../indicators";

export interface DecisionAudit {
  id: string;
  timestamp: string;
  pair: string;

  // 最終判断
  finalAction: CryptoAction;
  finalConfidence: number;
  finalReason: string;

  // 判断の内訳（投票結果）
  votes: {
    source: string;      // "quant" | "ai" | "regime" | "technical"
    action: CryptoAction;
    score: number;        // -100 ~ +100
    confidence: number;
    weight: number;
    reasons: string[];
  }[];

  // 市場状態スナップショット
  marketState: {
    price: number;
    regime: MarketRegime;
    fearGreedIndex: number;
    technicalScore: number;
  };

  // クオンツ詳細（各シグナルの生データ）
  quantSignals?: QuantAnalysis["signals"];

  // 結果（後から記録）
  outcome?: {
    exitPrice?: number;
    pnl?: number;
    pnlPercent?: number;
    holdDuration?: number; // minutes
    wasCorrect?: boolean;
  };
}

const MAX_AUDIT_ENTRIES = 1000;

export async function saveAudit(audit: DecisionAudit): Promise<void> {
  const audits = await loadData<DecisionAudit[]>("decision-audits", []);
  audits.push(audit);
  await saveData("decision-audits", audits.slice(-MAX_AUDIT_ENTRIES));
}

export async function getAudits(limit = 50): Promise<DecisionAudit[]> {
  const audits = await loadData<DecisionAudit[]>("decision-audits", []);
  return audits.slice(-limit);
}

/** 取引結果を監査ログに紐付ける */
export async function recordOutcome(
  pair: string,
  exitPrice: number,
  pnl: number,
  pnlPercent: number,
): Promise<void> {
  const audits = await loadData<DecisionAudit[]>("decision-audits", []);

  // 直近のBUY監査を探して結果を記録
  for (let i = audits.length - 1; i >= 0; i--) {
    if (audits[i].pair === pair && audits[i].finalAction === "BUY" && !audits[i].outcome) {
      const entryTime = new Date(audits[i].timestamp).getTime();
      audits[i].outcome = {
        exitPrice,
        pnl,
        pnlPercent,
        holdDuration: Math.round((Date.now() - entryTime) / 60000),
        wasCorrect: pnl > 0,
      };
      break;
    }
  }

  await saveData("decision-audits", audits);
}

/** パフォーマンスサマリー（Phase 2の自己改善で使用） */
export async function getPerformanceSummary(): Promise<{
  totalDecisions: number;
  buyDecisions: number;
  sellDecisions: number;
  holdDecisions: number;
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
  signalAccuracy: Record<string, { correct: number; total: number; accuracy: number }>;
}> {
  const audits = await loadData<DecisionAudit[]>("decision-audits", []);

  const buys = audits.filter(a => a.finalAction === "BUY");
  const sells = audits.filter(a => a.finalAction === "SELL");
  const holds = audits.filter(a => a.finalAction === "HOLD");
  const completed = audits.filter(a => a.outcome?.pnl !== undefined);
  const wins = completed.filter(a => (a.outcome?.pnl ?? 0) > 0);
  const losses = completed.filter(a => (a.outcome?.pnl ?? 0) < 0);

  // シグナル別の精度分析
  const signalAccuracy: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const audit of completed) {
    const wasCorrect = audit.outcome?.wasCorrect ?? false;
    for (const vote of audit.votes) {
      if (!signalAccuracy[vote.source]) {
        signalAccuracy[vote.source] = { correct: 0, total: 0, accuracy: 0 };
      }
      signalAccuracy[vote.source].total++;
      const voteWasRight = (vote.action === "BUY" && wasCorrect) || (vote.action === "SELL" && !wasCorrect);
      if (voteWasRight) signalAccuracy[vote.source].correct++;
    }
  }
  for (const key of Object.keys(signalAccuracy)) {
    const s = signalAccuracy[key];
    s.accuracy = s.total > 0 ? (s.correct / s.total) * 100 : 0;
  }

  return {
    totalDecisions: audits.length,
    buyDecisions: buys.length,
    sellDecisions: sells.length,
    holdDecisions: holds.length,
    completedTrades: completed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
    avgPnlPercent: completed.length > 0
      ? completed.reduce((s, a) => s + (a.outcome?.pnlPercent ?? 0), 0) / completed.length
      : 0,
    signalAccuracy,
  };
}
