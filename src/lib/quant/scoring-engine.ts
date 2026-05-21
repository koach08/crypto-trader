/**
 * スコアリングエンジン（合議制意思決定）
 *
 * LLMを「判断者」から「アドバイザーの1人」に格下げ。
 * 最終判断は複数のソースからの重み付きスコアで決定する。
 *
 * ソース：
 * 1. クオンツシグナル（統計的分析）    重み: 40%
 * 2. AIコンセンサス（LLM意見）         重み: 25%
 * 3. テクニカル指標（既存スコア）      重み: 20%
 * 4. 市場レジーム（相場タイプ）        重み: 15%
 */

import type { CryptoAction } from "../types";
import type { QuantAnalysis } from "./signals";
import type { MarketRegime } from "../indicators";
import type { DecisionAudit } from "./audit-log";

interface ScoringInput {
  pair: string;
  price: number;

  // クオンツシグナル
  quantAnalysis: QuantAnalysis;

  // AI判断（LLM）
  aiAction: CryptoAction;
  aiConfidence: number;
  aiReason: string;

  // テクニカルスコア（既存）
  technicalScore: number; // -5 ~ +5

  // 市場レジーム
  regime: MarketRegime;

  // Fear & Greed
  fearGreedIndex: number;

  /** スキャル mode: RANGING で頻度優先、閾値半減 */
  scalpMode?: boolean;

  /** investment-app からのマルチソース bias (-100 〜 +100) */
  externalBias?: { score: number; reason: string } | null;

  /** intel (whale + community + funding) bias (-100 〜 +100) */
  intelBias?: { score: number; reason: string } | null;
}

interface ScoringResult {
  action: CryptoAction;
  confidence: number;
  reason: string;
  audit: Omit<DecisionAudit, "id" | "timestamp" | "outcome">;
}

// ソースごとの重み（合計100%）
// Intel (whale/community/funding) 統合で再分配
const WEIGHTS = {
  quant: 0.30,        // 0.35 → 0.30
  ai: 0.10,
  technical: 0.10,    // 0.15 → 0.10
  regime: 0.20,
  external: 0.15,     // 0.20 → 0.15
  intel: 0.15,        // ★新規: on-chain whale + community sentiment + funding rate
};

// 取引閾値: 「動かない bot は人間以下」。動く方向で全面緩和。
// 負け筋ガード = TP/SL/緊急ロスカット/MTF/EV が下流で効くので入口は広めに。
const MIN_ABS_SCORE = 8;
const MIN_AGREEMENT = 0.51;          // 過半数
const QUANT_STRONG_OVERRIDE = 15;    // Quant 単独 ≥15 で発火

// スキャル mode (RANGING + maker手数料0%): 頻度で稼ぐので閾値半減
const SCALP_MIN_ABS_SCORE = 4;
const SCALP_MIN_AGREEMENT = 0.51;    // 一致度は変えない (品質維持)
const SCALP_QUANT_OVERRIDE = 8;

/** AI判断をスコアに変換 */
function aiToScore(action: CryptoAction, confidence: number): number {
  const base = action === "BUY" ? 1 : action === "SELL" ? -1 : 0;
  return base * confidence; // -100 ~ +100
}

/** テクニカルスコアを-100~+100に正規化 */
function normalizeTechnical(score: number): number {
  return Math.max(-100, Math.min(100, score * 20)); // -5~+5 → -100~+100
}

/** レジームをスコアに変換 */
function regimeToScore(regime: MarketRegime): { score: number; reason: string } {
  switch (regime) {
    case "TRENDING_UP":
      return { score: 40, reason: "上昇トレンド - 買い優勢環境" };
    case "TRENDING_DOWN":
      return { score: -40, reason: "下降トレンド - 売り優勢環境" };
    case "VOLATILE":
      return { score: -20, reason: "高ボラ - 取引控えめ推奨" };
    case "RANGING":
      return { score: 0, reason: "レンジ相場 - 方向感なし" };
  }
}

export function calculateFinalDecision(input: ScoringInput): ScoringResult {
  const quantScore = input.quantAnalysis.compositeScore;
  const aiScore = aiToScore(input.aiAction, input.aiConfidence);
  const techScore = normalizeTechnical(input.technicalScore);
  const regimeResult = regimeToScore(input.regime);
  const externalScore = input.externalBias?.score ?? 0;
  const intelScore = input.intelBias?.score ?? 0;

  // 加重平均スコア
  const compositeScore =
    quantScore * WEIGHTS.quant +
    aiScore * WEIGHTS.ai +
    techScore * WEIGHTS.technical +
    regimeResult.score * WEIGHTS.regime +
    externalScore * WEIGHTS.external +
    intelScore * WEIGHTS.intel;

  // 各ソースの一致度チェック: 「方向のあるソース」のみカウント (HOLD/0は除外)
  const directions = [
    Math.sign(quantScore),
    Math.sign(aiScore),
    Math.sign(techScore),
    Math.sign(regimeResult.score),
    Math.sign(externalScore),
    Math.sign(intelScore),
  ];
  const directional = directions.filter((d) => d !== 0);
  const buyVotes = directional.filter((d) => d > 0).length;
  const sellVotes = directional.filter((d) => d < 0).length;
  const totalVotes = Math.max(1, directional.length);
  const agreement = Math.max(buyVotes, sellVotes) / totalVotes;

  // 信頼度 = ソース一致度 × 平均信頼度
  const confidence = Math.round(
    agreement * 100 * 0.6 +
    input.quantAnalysis.compositeConfidence * 0.2 +
    input.aiConfidence * 0.2
  );

  // 最終アクション決定
  let action: CryptoAction;
  const absScore = Math.abs(compositeScore);
  const absQuant = Math.abs(quantScore);

  // スキャル mode (RANGING + maker 0%) は閾値を半減して頻度優先
  const minScore = input.scalpMode ? SCALP_MIN_ABS_SCORE : MIN_ABS_SCORE;
  const minAgreement = input.scalpMode ? SCALP_MIN_AGREEMENT : MIN_AGREEMENT;
  const quantOverride = input.scalpMode ? SCALP_QUANT_OVERRIDE : QUANT_STRONG_OVERRIDE;

  // STRONG_OVERRIDE: Quant単独で十分強ければ一致度無視で発火
  // (RenTech 的な統計ベース。「他ソースが追いついてないだけ」の場合の機会)
  if (absQuant >= quantOverride) {
    action = quantScore > 0 ? "BUY" : "SELL";
  } else if (absScore < minScore || agreement < minAgreement) {
    // 中程度以下: スコア弱いか、方向ソース間で意見割れ → HOLD
    action = "HOLD";
  } else if (compositeScore > 0) {
    action = "BUY";
  } else {
    action = "SELL";
  }

  // 判断理由を構築
  const reasons: string[] = [];
  if (Math.abs(quantScore) >= 20) {
    reasons.push(`クオンツ: ${quantScore > 0 ? "買い" : "売り"}シグナル (${quantScore}pt)`);
  }
  if (Math.abs(aiScore) >= 30) {
    reasons.push(`AI: ${input.aiAction} 確信度${input.aiConfidence}%`);
  }
  if (Math.abs(techScore) >= 40) {
    reasons.push(`テクニカル: ${techScore > 0 ? "買い" : "売り"} (${input.technicalScore})`);
  }
  reasons.push(`レジーム: ${regimeResult.reason}`);
  if (input.externalBias && Math.abs(externalScore) >= 10) {
    reasons.push(`外部: ${externalScore > 0 ? "買い" : "売り"}寄り (${externalScore.toFixed(0)}pt) ${input.externalBias.reason}`);
  }
  if (input.intelBias && Math.abs(intelScore) >= 10) {
    reasons.push(`Intel: ${intelScore > 0 ? "買い" : "売り"}寄り (${intelScore.toFixed(0)}pt) ${input.intelBias.reason}`);
  }

  const reason = `[総合${compositeScore.toFixed(0)}pt, 一致${(agreement * 100).toFixed(0)}%] ${reasons.join(" | ")}`;

  // 監査ログ用データ
  const audit: Omit<DecisionAudit, "id" | "timestamp" | "outcome"> = {
    pair: input.pair,
    finalAction: action,
    finalConfidence: confidence,
    finalReason: reason,
    votes: [
      {
        source: "quant",
        action: quantScore > 15 ? "BUY" : quantScore < -15 ? "SELL" : "HOLD",
        score: quantScore,
        confidence: input.quantAnalysis.compositeConfidence,
        weight: WEIGHTS.quant,
        reasons: input.quantAnalysis.reasons,
      },
      {
        source: "ai",
        action: input.aiAction,
        score: aiScore,
        confidence: input.aiConfidence,
        weight: WEIGHTS.ai,
        reasons: [input.aiReason],
      },
      {
        source: "technical",
        action: techScore > 40 ? "BUY" : techScore < -40 ? "SELL" : "HOLD",
        score: techScore,
        confidence: 70,
        weight: WEIGHTS.technical,
        reasons: [`テクニカルスコア: ${input.technicalScore}`],
      },
      {
        source: "regime",
        action: regimeResult.score > 20 ? "BUY" : regimeResult.score < -20 ? "SELL" : "HOLD",
        score: regimeResult.score,
        confidence: 75,
        weight: WEIGHTS.regime,
        reasons: [regimeResult.reason],
      },
      {
        source: "external",
        action: externalScore > 15 ? "BUY" : externalScore < -15 ? "SELL" : "HOLD",
        score: externalScore,
        confidence: input.externalBias ? 70 : 0,
        weight: WEIGHTS.external,
        reasons: input.externalBias ? [input.externalBias.reason] : ["external 取得失敗"],
      },
      {
        source: "intel",
        action: intelScore > 15 ? "BUY" : intelScore < -15 ? "SELL" : "HOLD",
        score: intelScore,
        confidence: input.intelBias ? 70 : 0,
        weight: WEIGHTS.intel,
        reasons: input.intelBias ? [input.intelBias.reason] : ["intel 取得失敗"],
      },
    ],
    marketState: {
      price: input.price,
      regime: input.regime,
      fearGreedIndex: input.fearGreedIndex,
      technicalScore: input.technicalScore,
    },
    quantSignals: input.quantAnalysis.signals,
  };

  return { action, confidence, reason, audit };
}
