/**
 * Phase 2 自己改善ループ
 *
 * 監査ログから各シグナルの実勝率を計測し、SIGNAL_WEIGHTS を補正する。
 *
 * 設計原則:
 *  - サンプル不足時は baseline weights を使用 (無闇に変えない)
 *  - 過剰適応防止のため baseline と blend (50:50)
 *  - シグナルが弱い (|score| < 5) ものは集計対象外 (ノイズ)
 *  - "agreed direction & winning trade" or "disagreed direction & losing trade" を correct とカウント
 */

import type { DecisionAudit } from "./audit-log";

const MIN_SAMPLES_PER_SIGNAL = 30;
const BLEND_RATIO = 0.5; // 学習50% + baseline50%
const SIGNAL_THRESHOLD = 5; // |score| この未満はノイズとして除外

export interface SignalAccuracy {
  name: string;
  total: number;
  correct: number;
  accuracy: number;
  weightMultiplier: number;
}

export interface LearningSummary {
  baseline: Record<string, number>;
  learned: Record<string, number>;
  perSignal: SignalAccuracy[];
  totalAudits: number;
  completedAudits: number;
  ready: boolean;
}

/**
 * シグナルが取った方向と実際の取引結果が一致してたかをペアごとに集計。
 * agreed & win, disagreed & loss → correct
 * agreed & loss, disagreed & win → incorrect
 */
export function computeSignalAccuracies(
  audits: DecisionAudit[]
): Record<string, { correct: number; total: number }> {
  const stats: Record<string, { correct: number; total: number }> = {};

  for (const audit of audits) {
    if (!audit.outcome || audit.outcome.wasCorrect === undefined) continue;
    if (!audit.quantSignals || audit.quantSignals.length === 0) continue;

    const tradeWasWin = audit.outcome.wasCorrect;
    const actionTaken = audit.finalAction;
    if (actionTaken === "HOLD") continue; // HOLD には outcome がない、念のため

    for (const sig of audit.quantSignals) {
      if (sig.confidence <= 0 || Math.abs(sig.score) < SIGNAL_THRESHOLD) continue;

      if (!stats[sig.name]) stats[sig.name] = { correct: 0, total: 0 };
      stats[sig.name].total++;

      const signalDirection = sig.score > 0 ? "BUY" : "SELL";
      const signalAgreed = signalDirection === actionTaken;
      const correct = (signalAgreed && tradeWasWin) || (!signalAgreed && !tradeWasWin);
      if (correct) stats[sig.name].correct++;
    }
  }

  return stats;
}

/**
 * accuracy [0.0..1.0] → weight multiplier [0.3..2.0]
 *  0.5 (ランダム) → 1.0倍
 *  0.6 (良)      → 1.5倍
 *  0.4 (悪)      → 0.5倍
 */
function accuracyToMultiplier(accuracy: number): number {
  const m = 1.0 + (accuracy - 0.5) * 5; // ±0.1で±0.5の感度
  return Math.max(0.3, Math.min(2.0, m));
}

export function computeLearnedWeights(
  audits: DecisionAudit[],
  baseline: Record<string, number>
): LearningSummary {
  const stats = computeSignalAccuracies(audits);
  const learned: Record<string, number> = { ...baseline };
  const perSignal: SignalAccuracy[] = [];

  let anyLearned = false;
  for (const [name, base] of Object.entries(baseline)) {
    const s = stats[name];
    if (!s || s.total < MIN_SAMPLES_PER_SIGNAL) {
      perSignal.push({
        name,
        total: s?.total ?? 0,
        correct: s?.correct ?? 0,
        accuracy: s && s.total > 0 ? s.correct / s.total : 0,
        weightMultiplier: 1.0,
      });
      continue;
    }
    const accuracy = s.correct / s.total;
    const multiplier = accuracyToMultiplier(accuracy);
    learned[name] = base * multiplier * BLEND_RATIO + base * (1 - BLEND_RATIO);
    perSignal.push({
      name,
      total: s.total,
      correct: s.correct,
      accuracy,
      weightMultiplier: multiplier,
    });
    anyLearned = true;
  }

  return {
    baseline,
    learned,
    perSignal,
    totalAudits: audits.length,
    completedAudits: audits.filter((a) => a.outcome?.wasCorrect !== undefined).length,
    ready: anyLearned,
  };
}
