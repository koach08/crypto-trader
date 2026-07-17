/**
 * Phase 2 自己改善ループ (ベイズ縮小推定版)
 *
 * 監査ログから各シグナルの実勝率を計測し、SIGNAL_WEIGHTS を補正する。
 *
 * 旧設計の問題:
 *  - 「各シグナル30サンプル」の硬いゲート → 完了取引が過疎 (実測: 3943サイクルで15件)
 *    なため事実上到達不能。ループが永久に起動しなかった。
 *  - さらに50:50固定ブレンド + 線形multiplier で、閾値を超えた瞬間に薄い証拠で過剰反応する。
 *
 * 新設計 (Beta-Binomial 縮小):
 *  - 各シグナルの勝率を Beta(α0, β0) 事前分布 (中心0.5) で縮小推定する。
 *    posteriorMean = (correct + α0) / (total + α0 + β0)
 *    → サンプルが少なければ 0.5 (=中立=baseline) に自動的に引き戻される。
 *    → 「今ある少数データ」からでも過学習せず起動できる。証拠が増えるほど強く動く。
 *  - multiplier は posteriorMean からのみ算出。サンプル0なら自動的に 1.0 (baseline) になる。
 *  - MIN_SAMPLES_FLOOR 未満のシグナルは触らない (純粋にノイズ領域)。
 *  - multiplier は [0.5, 1.6] にクランプ。薄い証拠で1つのシグナルを潰しきらない安全弁。
 *  - シグナルが弱い (|score| < SIGNAL_THRESHOLD) 局面は集計対象外 (ノイズ)。
 *  - "agreed direction & winning trade" or "disagreed direction & losing trade" を correct とカウント。
 */

import type { DecisionAudit } from "./audit-log";

/** この件数未満のシグナルはウェイトを動かさない (証拠不足) */
const MIN_SAMPLES_FLOOR = 6;
/** Beta 事前分布の擬似観測数 (α0=β0=PRIOR_STRENGTH/2, 中心0.5)。大きいほど保守的 */
const PRIOR_STRENGTH = 12;
/** posteriorMean の 0.5 からの乖離をウェイト倍率へ変換する感度 */
const SENSITIVITY = 4.0;
/** ウェイト倍率のクランプ (薄い証拠で潰しきらない / 過信しない安全弁) */
const MULT_MIN = 0.5;
const MULT_MAX = 1.6;
/** |score| この未満はノイズとして除外 */
const SIGNAL_THRESHOLD = 5;

const PRIOR_A = PRIOR_STRENGTH / 2; // α0
const PRIOR_B = PRIOR_STRENGTH / 2; // β0

export interface SignalAccuracy {
  name: string;
  total: number;
  correct: number;
  /** 生の勝率 (correct/total)。サンプル0なら0 */
  accuracy: number;
  /** Beta事前で縮小した推定勝率。ウェイト算出の実体 */
  posteriorMean: number;
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
 * Beta(α0,β0) 事前で縮小した推定勝率。
 * total=0 → 0.5 (中立)。サンプルが増えるほど生の勝率へ寄る。
 */
export function shrunkAccuracy(correct: number, total: number): number {
  return (correct + PRIOR_A) / (total + PRIOR_A + PRIOR_B);
}

/**
 * 縮小推定勝率 → weight multiplier [MULT_MIN..MULT_MAX]
 *  0.5 (ランダム/証拠なし) → 1.0倍
 *  0.6 → 1.4倍 / 0.4 → 0.6倍  (SENSITIVITY=4)
 * 縮小推定を通しているので、サンプルが少ないほど 1.0 に近づき自然に保守的になる。
 */
function posteriorToMultiplier(posteriorMean: number): number {
  const m = 1.0 + (posteriorMean - 0.5) * SENSITIVITY;
  return Math.max(MULT_MIN, Math.min(MULT_MAX, m));
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
    const total = s?.total ?? 0;
    const correct = s?.correct ?? 0;

    // 証拠不足のシグナルは触らない (baseline のまま)
    if (total < MIN_SAMPLES_FLOOR) {
      perSignal.push({
        name,
        total,
        correct,
        accuracy: total > 0 ? correct / total : 0,
        posteriorMean: shrunkAccuracy(correct, total),
        weightMultiplier: 1.0,
      });
      continue;
    }

    const posteriorMean = shrunkAccuracy(correct, total);
    const multiplier = posteriorToMultiplier(posteriorMean);
    learned[name] = base * multiplier;
    perSignal.push({
      name,
      total,
      correct,
      accuracy: correct / total,
      posteriorMean,
      weightMultiplier: multiplier,
    });
    // multiplier が実質的に 1.0 でなければ「学習した」とみなす
    if (Math.abs(multiplier - 1.0) > 0.01) anyLearned = true;
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
