/**
 * Position style 判定: 1 取引を「短期/中期/長期」のどれで運用するか決める.
 *
 * 同じ BUY シグナルでも、入る条件次第で TP/SL を変える:
 *   - SCALP: ノイズで小さく稼ぐ (TP 0.5-1.5%, hold 数時間)
 *   - SWING: 数日かけて取る (TP 3-8%, hold 数日)
 *   - HOLD:  長期保有、大きい move を待つ (TP 15-50%, hold 数週-数ヶ月)
 *
 * 振分 logic:
 *   HOLD ← 長期歴史的安値圏 + F&G 極度恐怖 + MTF 長期 DEEP_VALUE
 *   SWING ← 中期 reversal + 強い composite + マルチソース合意
 *   SCALP ← 通常 (短期 quant edge のみ)
 */

import type { MarketRegime } from "../indicators";
import type { MultiTimeframeAnalysis } from "../quant/timeframe-analyzer";
import type { TimingOpportunity } from "../quant/timing";

export type PositionStyle = "SCALP" | "SWING" | "HOLD";

export interface PartialTakeProfit {
  /** この value で部分利確発火 (+X%) */
  triggerPercent: number;
  /** 残量の何%を売るか (0-1) */
  sellRatio: number;
  /** 売却後の SL を entry からどこに移すか (+X%、0なら breakeven) */
  newSlPercent: number;
}

export interface StyleParams {
  style: PositionStyle;
  /** 最終 TP (これに達したら全量売却 = position close) */
  tpPercent: number;
  slPercent: number;
  /** ポジション size 倍率 (HOLD は大きく、SCALP は小さく) */
  sizeMultiplier: number;
  /** 想定保有期間 (cycle 単位) */
  expectedCycles: number;
  /** 部分利確段階 (最大 3 段)。空配列 = PTP なし (SCALP は通常空) */
  partialTakeProfits: PartialTakeProfit[];
  reasoning: string;
}

interface ClassifyInput {
  composite: number;
  regime: MarketRegime;
  fearGreed: number;
  mtf?: MultiTimeframeAnalysis | null;
  bottomOp?: TimingOpportunity | null;
  /** AI override で BUY override されたか */
  isOverride?: boolean;
}

/**
 * 「HOLD 級の好機」判定: 歴史的安値 + 極度恐怖 + マルチタイムフレーム合意
 */
function isHoldOpportunity(input: ClassifyInput): boolean {
  // F&G 極度恐怖 (≤25) + MTF 長期 DEEP_VALUE or VALUE
  const fgExtreme = input.fearGreed <= 25;
  const longTermCheap = input.mtf?.long.label === "DEEP_VALUE" || input.mtf?.long.label === "VALUE";
  // 底打ち検出 4/4 揃ってる強いシグナル
  const strongBottom = input.bottomOp?.fire === true && input.bottomOp.confidence >= 85;
  // 3 つのうち 2 つ以上揃ったら HOLD 級
  const hits = [fgExtreme, longTermCheap, strongBottom].filter(Boolean).length;
  return hits >= 2;
}

/**
 * 「SWING 級」判定: 中期反転 + 強い composite
 */
function isSwingOpportunity(input: ClassifyInput): boolean {
  // 中期 (4h) で VALUE 寄り
  const midCheap = input.mtf?.medium.label === "VALUE" || input.mtf?.medium.label === "DEEP_VALUE";
  // composite 強め
  const strongComposite = Math.abs(input.composite) >= 15;
  // upward bias or bottom signal moderate
  const trendingFavorable = input.regime === "TRENDING_UP" || (input.bottomOp?.fire === true && input.bottomOp.confidence >= 65);
  const hits = [midCheap, strongComposite, trendingFavorable].filter(Boolean).length;
  return hits >= 2;
}

export function classifyPositionStyle(input: ClassifyInput): StyleParams {
  // HOLD 判定 (最優先、長期チャンス) — 段階的に利確しつつ大半 hold
  if (isHoldOpportunity(input)) {
    return {
      style: "HOLD",
      tpPercent: 30,
      slPercent: 8,
      sizeMultiplier: 1.5,
      expectedCycles: 200,
      // 段階利確: +5% で 25% 売る → +12% で更に 25% → +25% で更に 25% → 残り 25% を hold
      partialTakeProfits: [
        { triggerPercent: 5, sellRatio: 0.25, newSlPercent: 0 },     // 25% 売り、SL を breakeven
        { triggerPercent: 12, sellRatio: 0.33, newSlPercent: 5 },    // 残りの 33% (=25%) 売り、SL を +5%
        { triggerPercent: 25, sellRatio: 0.5, newSlPercent: 12 },    // 残りの 50% (=25%) 売り、SL を +12%
        // 残り 25% は trailing stop で運用 (大きく取りに行く)
      ],
      reasoning: `長期 ${input.mtf?.long.label ?? "?"} + F&G ${input.fearGreed} + 底値圏 → HOLD 級 (段階利確 + 残り長期保有)`,
    };
  }

  // SWING 判定 — 半分利確、半分残す
  if (isSwingOpportunity(input)) {
    return {
      style: "SWING",
      tpPercent: 8,
      slPercent: 2,
      sizeMultiplier: 1.2,
      expectedCycles: 50,
      partialTakeProfits: [
        { triggerPercent: 3, sellRatio: 0.5, newSlPercent: 0 }, // +3% で半分売却、SL を breakeven
        // 残り 50% は最終 TP 8% または trailing stop で
      ],
      reasoning: `中期チャンス: composite ${input.composite}, ${input.regime}, MTF mid ${input.mtf?.medium.label ?? "?"}`,
    };
  }

  // SCALP デフォルト: 部分利確なし (小さすぎる)
  return {
    style: "SCALP",
    tpPercent: 1.2,
    slPercent: 0.6,
    sizeMultiplier: 1.0,
    expectedCycles: 5,
    partialTakeProfits: [], // SCALP は分割しない
    reasoning: `通常 scalp (composite ${input.composite}, regime ${input.regime})`,
  };
}
