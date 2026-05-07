/**
 * 取引規律モジュール
 *
 * Alpha Arena 研究の教訓:
 *  - 勝つモデルは「規律ある低頻度・厳格損切・テクニカル優先」
 *  - 負けるモデルは「過剰取引・センチメント追従・ヘッジなし」
 *
 * このモジュールは「期待値プラスの取引のみ通す」ためのフィルタ群:
 *  1. マルチタイムフレーム整合性 - h1とh4のトレンドが揃っているか
 *  2. 期待値ゲート - 手数料を引いてもプラスEVか
 *  3. 信頼度キャリブレーション - AIの「80%」は本当に80%か（監査ログで補正）
 *  4. トレーリングストップ - 勝ち幅を最大化
 */

import type { OHLCVBar } from "../types";
import { sma } from "../indicators";
import type { DecisionAudit } from "../quant/audit-log";

// BitFlyer の現物取引手数料（taker, 一般ユーザ）。Lightning Pro の費用構造に基づく目安
// https://bitflyer.com/ja-jp/s/commission
const BITFLYER_TAKER_FEE = 0.0015; // 0.15%
const ROUNDTRIP_FEE_PERCENT = BITFLYER_TAKER_FEE * 2 * 100; // % 表記、約 0.30%

// === 1. マルチタイムフレーム整合性 ===

export function resampleToHigherTF(bars: OHLCVBar[], factor: number): OHLCVBar[] {
  if (factor <= 1) return bars;
  const out: OHLCVBar[] = [];
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const slice = bars.slice(i, i + factor);
    out.push({
      timestamp: slice[0].timestamp,
      open: slice[0].open,
      high: Math.max(...slice.map((b) => b.high)),
      low: Math.min(...slice.map((b) => b.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

export interface MTFCheck {
  aligned: boolean;
  htfTrend: "UP" | "DOWN" | "FLAT";
  htfSlopePercent: number;
  reason: string;
}

/** h1 bars を渡すと、h4トレンドとの整合性を判定 */
export function checkMTFAlignment(
  h1Bars: OHLCVBar[],
  intendedAction: "BUY" | "SELL" | "HOLD"
): MTFCheck {
  if (intendedAction === "HOLD") {
    return { aligned: true, htfTrend: "FLAT", htfSlopePercent: 0, reason: "HOLDはMTF不要" };
  }
  const h4 = resampleToHigherTF(h1Bars, 4);
  if (h4.length < 12) {
    return { aligned: true, htfTrend: "FLAT", htfSlopePercent: 0, reason: "h4データ不足、フィルタ不適用" };
  }
  const closes = h4.map((b) => b.close);
  const sma10 = sma(closes, 10);
  const cur = sma10[sma10.length - 1];
  const prev5 = sma10[sma10.length - 6];
  if (cur === null || prev5 === null) {
    return { aligned: true, htfTrend: "FLAT", htfSlopePercent: 0, reason: "h4 SMA計算不能、フィルタ不適用" };
  }
  const slopePercent = ((cur - prev5) / prev5) * 100;
  let htfTrend: MTFCheck["htfTrend"];
  if (slopePercent > 0.5) htfTrend = "UP";
  else if (slopePercent < -0.5) htfTrend = "DOWN";
  else htfTrend = "FLAT";

  let aligned = true;
  let reason = "";
  if (intendedAction === "BUY" && htfTrend === "DOWN") {
    aligned = false;
    reason = `h4下降トレンド (傾き${slopePercent.toFixed(2)}%) で買いはMTF不一致`;
  } else if (intendedAction === "SELL" && htfTrend === "UP") {
    aligned = false;
    reason = `h4上昇トレンド (傾き+${slopePercent.toFixed(2)}%) で売りはMTF不一致`;
  } else {
    reason = `h4 ${htfTrend} (${slopePercent.toFixed(2)}%) と${intendedAction}方向一致`;
  }

  return { aligned, htfTrend, htfSlopePercent: slopePercent, reason };
}

// === 2. 期待値ゲート ===

export interface EdgeCheck {
  passed: boolean;
  expectedReturnPercent: number;
  feeBufferPercent: number;
  reason: string;
}

/**
 * 確信度・想定TP・想定SLから期待値を算出。手数料を引いた実質EVが正なら通す。
 *  EV = winRate * TP - (1-winRate) * SL - roundtripFees
 */
export function checkEdge(
  confidence: number,
  takeProfitPercent: number,
  stopLossPercent: number
): EdgeCheck {
  const winRate = Math.max(0, Math.min(1, confidence / 100));
  const grossEV = winRate * takeProfitPercent - (1 - winRate) * stopLossPercent;
  const netEV = grossEV - ROUNDTRIP_FEE_PERCENT;

  // 余裕係数: 手数料の 0.5倍以上の純EVがないと通さない（コインフリップ排除）
  const minEV = ROUNDTRIP_FEE_PERCENT * 0.5;
  const passed = netEV >= minEV;
  return {
    passed,
    expectedReturnPercent: Number(netEV.toFixed(2)),
    feeBufferPercent: ROUNDTRIP_FEE_PERCENT,
    reason: passed
      ? `EV +${netEV.toFixed(2)}% (TP${takeProfitPercent}/SL${stopLossPercent}, 勝率推定${(winRate * 100).toFixed(0)}%, 手数料${ROUNDTRIP_FEE_PERCENT.toFixed(2)}%)`
      : `EV ${netEV >= 0 ? "+" : ""}${netEV.toFixed(2)}% は手数料余裕${minEV.toFixed(2)}%未満。コインフリップ的取引のためスキップ`,
  };
}

// === 3. 信頼度キャリブレーション ===

export interface CalibrationResult {
  raw: number;
  calibrated: number;
  bucketSampleSize: number;
  bucketWinRate: number | null;
  reason: string;
}

/**
 * 監査ログの過去結果を使って、AIの確信度を実勝率に近づける。
 * サンプルが少ない場合は raw を返す（過信防止）。
 */
export function calibrateConfidence(
  audits: DecisionAudit[],
  rawConfidence: number
): CalibrationResult {
  const completed = audits.filter((a) => a.outcome?.wasCorrect !== undefined);
  if (completed.length < 20) {
    return {
      raw: rawConfidence,
      calibrated: rawConfidence,
      bucketSampleSize: completed.length,
      bucketWinRate: null,
      reason: `サンプル${completed.length}件 (<20) のためキャリブレーションなし`,
    };
  }

  const bucketSize = 10;
  const bucket = Math.floor(rawConfidence / bucketSize) * bucketSize;
  const sameBucket = completed.filter(
    (a) => Math.floor(a.finalConfidence / bucketSize) * bucketSize === bucket
  );

  if (sameBucket.length < 5) {
    return {
      raw: rawConfidence,
      calibrated: rawConfidence,
      bucketSampleSize: sameBucket.length,
      bucketWinRate: null,
      reason: `信頼度${bucket}-${bucket + bucketSize}%バケットのサンプルが${sameBucket.length}件 (<5)、生値使用`,
    };
  }

  const wins = sameBucket.filter((a) => a.outcome?.wasCorrect).length;
  const winRate = (wins / sameBucket.length) * 100;
  // 平滑化: キャリブレーション値70% + 生値30% (過剰適応防止)
  const calibrated = Math.round(winRate * 0.7 + rawConfidence * 0.3);

  return {
    raw: rawConfidence,
    calibrated,
    bucketSampleSize: sameBucket.length,
    bucketWinRate: winRate,
    reason: `信頼度${bucket}-${bucket + bucketSize}%の実勝率${winRate.toFixed(0)}% (n=${sameBucket.length}) → ${calibrated}%に補正`,
  };
}

// === 4. トレーリングストップ ===

export interface TrailingStopResult {
  newStopLossPercent: number;
  movedToBreakeven: boolean;
  trailing: boolean;
  reason: string;
}

/**
 * 含み益が breakevenTriggerPercent を超えたら SL をエントリー価格に移動。
 * さらに含み益拡大時は ATR ベースで追従（最大利益から ATR×1 引いた位置）。
 */
export function computeTrailingStop(args: {
  entryPrice: number;
  currentPrice: number;
  atr: number;
  currentStopLossPercent: number;
  breakevenTriggerPercent?: number;
  trailFactor?: number;
}): TrailingStopResult {
  const {
    entryPrice,
    currentPrice,
    atr,
    currentStopLossPercent,
    breakevenTriggerPercent = 1.0,
    trailFactor = 1.0,
  } = args;

  const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

  // まだブレイクイーブントリガに達してない → SL変更なし
  if (profitPercent < breakevenTriggerPercent) {
    return {
      newStopLossPercent: currentStopLossPercent,
      movedToBreakeven: false,
      trailing: false,
      reason: `含み益${profitPercent.toFixed(2)}% < トリガ${breakevenTriggerPercent}%、SL維持`,
    };
  }

  // ブレイクイーブン以上の利益 → SLを少なくとも0%(エントリー価格)に
  // SL は「エントリー価格からの下落%」で表現されるため、 0 = エントリー価格
  let newSL = 0;
  let trailing = false;

  // 含み益が ATR × trailFactor を超えるなら、その分追従
  const atrPercent = (atr / entryPrice) * 100;
  if (profitPercent > atrPercent * trailFactor * 2) {
    // 例: ATR 1%, trailFactor 1, 含み益5% → SLは 5% - 1% = 4%上 = -4%下落で発動
    // -4% は「エントリーから-4%」ではなく「現在値から-4%」相当に近い
    // SL = profit - atr*trailFactor として「これ以上下げると利確から後退」
    newSL = -(profitPercent - atrPercent * trailFactor);
    trailing = true;
  }

  // 既存SLより緩める方向には変更しない（一方通行）
  // currentSL は「エントリーから-X%」で X が大きいほど緩い
  // 例: 既存SL 2% (entry-2%で発動)、newSL -4% → newSL は entry+4% = 利益確定方向
  // この場合 newSL の方が「上」なので採用
  const finalSL = Math.min(currentStopLossPercent, newSL);

  return {
    newStopLossPercent: finalSL,
    movedToBreakeven: !trailing && finalSL <= 0,
    trailing,
    reason: trailing
      ? `含み益${profitPercent.toFixed(2)}% トレーリング中 (SL ${finalSL.toFixed(2)}%)`
      : `含み益${profitPercent.toFixed(2)}% ブレイクイーブンへSL移動 (${finalSL.toFixed(2)}%)`,
  };
}
