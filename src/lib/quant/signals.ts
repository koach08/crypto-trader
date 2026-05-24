/**
 * クオンツシグナル層
 * LLMに依存しない、統計的・数学的根拠に基づく売買シグナル生成
 *
 * 設計思想：
 * - 各シグナルは独立に計算され、根拠（reason）を必ず返す
 * - スコアは -100（強い売り）〜 +100（強い買い）の範囲
 * - 判断の透明性：なぜそのスコアになったか追跡可能
 */

import type { OHLCVBar } from "../types";
import { sma, ema, rsi, bollingerBands, atr } from "../indicators";

export interface QuantSignal {
  name: string;
  score: number;      // -100 ~ +100
  confidence: number;  // 0 ~ 100 (データ信頼度)
  reason: string;      // なぜこのスコアになったか
  factors: Record<string, number | string>; // 判断に使った数値（監査用）
}

export interface QuantAnalysis {
  signals: QuantSignal[];
  compositeScore: number;     // 加重平均スコア
  compositeConfidence: number; // 全体の信頼度
  recommendation: "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";
  reasons: string[];           // 判断根拠の要約
}

// === 個別シグナル ===

/** RSI平均回帰シグナル: 過剰売買からの反転を狙う */
function rsiMeanReversion(bars: OHLCVBar[]): QuantSignal {
  const closes = bars.map(b => b.close);
  const rsiVals = rsi(closes, 14);
  const current = rsiVals[rsiVals.length - 1];
  const prev = rsiVals[rsiVals.length - 2];

  if (current == null || prev == null) {
    return { name: "RSI平均回帰", score: 0, confidence: 0, reason: "データ不足", factors: {} };
  }

  let score = 0;
  let reason = "";

  if (current < 25) {
    score = 80;
    reason = `RSI ${current.toFixed(1)} - 極端な売られすぎ、反発の可能性高い`;
  } else if (current < 35) {
    score = 40;
    reason = `RSI ${current.toFixed(1)} - 売られすぎ圏、買い検討`;
  } else if (current > 75) {
    score = -80;
    reason = `RSI ${current.toFixed(1)} - 極端な買われすぎ、反落の可能性高い`;
  } else if (current > 65) {
    score = -40;
    reason = `RSI ${current.toFixed(1)} - 買われすぎ圏、売り検討`;
  } else {
    score = 0;
    reason = `RSI ${current.toFixed(1)} - 中立圏`;
  }

  // RSIの方向性（上昇中か下降中か）で微調整
  const direction = current - prev;
  if (direction > 3 && score >= 0) score += 10;
  if (direction < -3 && score <= 0) score -= 10;

  return {
    name: "RSI平均回帰",
    score: Math.max(-100, Math.min(100, score)),
    confidence: 85,
    reason,
    factors: { rsi: current, rsiPrev: prev, direction },
  };
}

/** ボリンジャーバンド逆張り: バンド外からの回帰を狙う */
function bollingerReversion(bars: OHLCVBar[]): QuantSignal {
  const closes = bars.map(b => b.close);
  const bb = bollingerBands(closes, 20, 2);
  const lastIdx = bb.upper.length - 1;
  const upper = bb.upper[lastIdx];
  const lower = bb.lower[lastIdx];
  const middle = bb.middle[lastIdx];
  const price = closes[closes.length - 1];

  if (!upper || !lower || !middle) {
    return { name: "ボリンジャー逆張り", score: 0, confidence: 0, reason: "データ不足", factors: {} };
  }

  const bandWidth = upper - lower;
  const position = bandWidth > 0 ? (price - lower) / bandWidth : 0.5; // 0=下限, 1=上限

  let score = 0;
  let reason = "";

  if (position < 0) {
    score = 70;
    reason = `価格がBB下限を下回り (位置: ${(position * 100).toFixed(0)}%)、反発の可能性`;
  } else if (position < 0.15) {
    score = 40;
    reason = `BB下限付近 (位置: ${(position * 100).toFixed(0)}%)、買いゾーン`;
  } else if (position > 1) {
    score = -70;
    reason = `価格がBB上限を上回り (位置: ${(position * 100).toFixed(0)}%)、反落の可能性`;
  } else if (position > 0.85) {
    score = -40;
    reason = `BB上限付近 (位置: ${(position * 100).toFixed(0)}%)、売りゾーン`;
  } else {
    score = 0;
    reason = `BB中間圏 (位置: ${(position * 100).toFixed(0)}%)、方向感なし`;
  }

  return {
    name: "ボリンジャー逆張り",
    score: Math.max(-100, Math.min(100, score)),
    confidence: 75,
    reason,
    factors: { price, upper, lower, middle, position, bandWidth },
  };
}

/** モメンタムシグナル: 移動平均線の関係と傾きから趨勢を判断 */
function momentumTrend(bars: OHLCVBar[]): QuantSignal {
  const closes = bars.map(b => b.close);
  if (closes.length < 50) {
    return { name: "モメンタム", score: 0, confidence: 0, reason: "データ不足", factors: {} };
  }

  const sma20Vals = sma(closes, 20);
  const sma50Vals = sma(closes, 50);
  const ema12Vals = ema(closes, 12);

  const sma20 = sma20Vals[sma20Vals.length - 1];
  const sma50 = sma50Vals[sma50Vals.length - 1];
  const sma20Prev10 = sma20Vals[sma20Vals.length - 10];
  const ema12 = ema12Vals[ema12Vals.length - 1];
  const price = closes[closes.length - 1];

  if (!sma20 || !sma50 || !sma20Prev10 || !ema12) {
    return { name: "モメンタム", score: 0, confidence: 0, reason: "計算不能", factors: {} };
  }

  let score = 0;
  const reasons: string[] = [];

  // ゴールデンクロス/デッドクロス
  if (sma20 > sma50) {
    score += 25;
    reasons.push("SMA20 > SMA50 (ゴールデンクロス圏)");
  } else {
    score -= 25;
    reasons.push("SMA20 < SMA50 (デッドクロス圏)");
  }

  // SMA20の傾き（上昇トレンドの強さ）
  const slopePercent = ((sma20 - sma20Prev10) / sma20Prev10) * 100;
  if (slopePercent > 1) {
    score += 30;
    reasons.push(`SMA20傾き +${slopePercent.toFixed(1)}% (強い上昇)`);
  } else if (slopePercent > 0.3) {
    score += 15;
    reasons.push(`SMA20傾き +${slopePercent.toFixed(1)}% (緩やかな上昇)`);
  } else if (slopePercent < -1) {
    score -= 30;
    reasons.push(`SMA20傾き ${slopePercent.toFixed(1)}% (強い下降)`);
  } else if (slopePercent < -0.3) {
    score -= 15;
    reasons.push(`SMA20傾き ${slopePercent.toFixed(1)}% (緩やかな下降)`);
  }

  // 価格と移動平均の位置関係
  if (price > ema12 && ema12 > sma20) {
    score += 20;
    reasons.push("価格 > EMA12 > SMA20 (強気配列)");
  } else if (price < ema12 && ema12 < sma20) {
    score -= 20;
    reasons.push("価格 < EMA12 < SMA20 (弱気配列)");
  }

  return {
    name: "モメンタム",
    score: Math.max(-100, Math.min(100, score)),
    confidence: 80,
    reason: reasons.join("; "),
    factors: { price, sma20, sma50, ema12, slopePercent },
  };
}

/** 出来高異常検知: 平常時と比較して出来高が急増しているか */
function volumeAnomaly(bars: OHLCVBar[]): QuantSignal {
  const volumes = bars.map(b => b.volume);
  if (volumes.length < 20) {
    return { name: "出来高異常", score: 0, confidence: 0, reason: "データ不足", factors: {} };
  }

  const recentVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  if (avgVol === 0) {
    return { name: "出来高異常", score: 0, confidence: 30, reason: "出来高データなし", factors: {} };
  }

  const ratio = recentVol / avgVol;
  const priceChange = bars.length >= 2
    ? ((bars[bars.length - 1].close - bars[bars.length - 2].close) / bars[bars.length - 2].close) * 100
    : 0;

  let score = 0;
  let reason = "";

  if (ratio > 3) {
    // 出来高急増 + 価格方向で判断
    score = priceChange > 0 ? 40 : -40;
    reason = `出来高 ${ratio.toFixed(1)}倍（急増）、価格${priceChange > 0 ? "上昇" : "下落"}方向`;
  } else if (ratio > 2) {
    score = priceChange > 0 ? 20 : -20;
    reason = `出来高 ${ratio.toFixed(1)}倍（増加）、価格${priceChange > 0 ? "上昇" : "下落"}方向`;
  } else if (ratio < 0.3) {
    score = 0;
    reason = `出来高 ${ratio.toFixed(1)}倍（極端に少ない）、シグナル信頼度低`;
  } else {
    score = 0;
    reason = `出来高 ${ratio.toFixed(1)}倍（通常範囲）`;
  }

  return {
    name: "出来高異常",
    score: Math.max(-100, Math.min(100, score)),
    confidence: ratio < 0.3 ? 20 : 60,
    reason,
    factors: { recentVol, avgVol, ratio, priceChange },
  };
}

/** ボラティリティ状態: ATRベースでリスク水準を判定 */
function volatilityState(bars: OHLCVBar[]): QuantSignal {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const atrVals = atr(highs, lows, closes, 14);
  const currentATR = atrVals[atrVals.length - 1];
  const price = closes[closes.length - 1];

  if (!currentATR || price <= 0) {
    return { name: "ボラティリティ", score: 0, confidence: 0, reason: "データ不足", factors: {} };
  }

  const atrPercent = (currentATR / price) * 100;

  // 過去のATRと比較
  const validATR = atrVals.filter((v): v is number => v !== null);
  const avgATR = validATR.length > 0 ? validATR.reduce((a, b) => a + b, 0) / validATR.length : currentATR;
  const atrRatio = avgATR > 0 ? currentATR / avgATR : 1;

  let score = 0;
  let reason = "";

  if (atrPercent > 5) {
    score = -30; // 高ボラ時は取引控えめ
    reason = `ATR ${atrPercent.toFixed(1)}%（高ボラティリティ）、取引リスク高`;
  } else if (atrRatio > 1.5) {
    score = -15;
    reason = `ATR比 ${atrRatio.toFixed(1)}倍（ボラ上昇中）、注意`;
  } else if (atrPercent < 0.5) {
    score = 5; // 低ボラ時はDCA向き
    reason = `ATR ${atrPercent.toFixed(1)}%（低ボラ）、安定した積立向き`;
  } else {
    score = 0;
    reason = `ATR ${atrPercent.toFixed(1)}%（通常範囲）`;
  }

  return {
    name: "ボラティリティ",
    score,
    confidence: 70,
    reason,
    factors: { atr: currentATR, atrPercent, atrRatio, price },
  };
}

/** ATRブレイクアウト: 直近20本高値/安値 + ATR×0.3 を超えるトレンド継続シグナル */
function atrBreakout(bars: OHLCVBar[]): QuantSignal {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const atrVals = atr(highs, lows, closes, 14);
  const currentATR = atrVals[atrVals.length - 1];
  const price = closes[closes.length - 1];

  if (currentATR == null || closes.length < 21 || price == null || price <= 0) {
    return { name: "ATRブレイクアウト", score: 0, confidence: 0, reason: "データ不足", factors: {} };
  }

  const lookback = 20;
  const recentHighs = highs.slice(-lookback - 1, -1); // 現在を除く20本
  const recentLows = lows.slice(-lookback - 1, -1);
  const breakoutHigh = Math.max(...recentHighs);
  const breakoutLow = Math.min(...recentLows);
  const buffer = currentATR * 0.3;

  let score = 0;
  let reason = "";

  if (price > breakoutHigh + buffer) {
    score = 70;
    reason = `${lookback}本高値¥${Math.round(breakoutHigh).toLocaleString()} + ATR×0.3 を超えるブレイクアウト`;
  } else if (price < breakoutLow - buffer) {
    score = -70;
    reason = `${lookback}本安値¥${Math.round(breakoutLow).toLocaleString()} - ATR×0.3 を割るブレイクダウン`;
  } else {
    const rangePosition = ((price - breakoutLow) / (breakoutHigh - breakoutLow)) * 100;
    reason = `レンジ内 (${lookback}本: ¥${Math.round(breakoutLow).toLocaleString()}〜¥${Math.round(breakoutHigh).toLocaleString()}, 位置${rangePosition.toFixed(0)}%)`;
  }

  const rangePosition = breakoutHigh > breakoutLow
    ? ((price - breakoutLow) / (breakoutHigh - breakoutLow)) * 100
    : 50;

  return {
    name: "ATRブレイクアウト",
    score,
    confidence: 80,
    reason,
    factors: {
      price: Number(price.toFixed(2)),
      breakoutHigh: Number(breakoutHigh.toFixed(2)),
      breakoutLow: Number(breakoutLow.toFixed(2)),
      atr: Number(currentATR.toFixed(2)),
      rangePosition: Number(rangePosition.toFixed(2)),
    },
  };
}

// === メインの合成関数 ===

export const BASELINE_SIGNAL_WEIGHTS: Record<string, number> = {
  "RSI平均回帰": 1.0,
  "ボリンジャー逆張り": 0.8,
  "モメンタム": 1.2,
  "出来高異常": 0.6,
  "ボラティリティ": 0.5,
  "ATRブレイクアウト": 1.5, // 新規、最高ウェイト
};

// 学習されたウェイト (Phase 2 自己改善ループで上書き)
let activeSignalWeights: Record<string, number> = { ...BASELINE_SIGNAL_WEIGHTS };

export function setActiveSignalWeights(weights: Record<string, number>): void {
  activeSignalWeights = { ...BASELINE_SIGNAL_WEIGHTS, ...weights };
}

export function getActiveSignalWeights(): Record<string, number> {
  return { ...activeSignalWeights };
}

export function runQuantAnalysis(bars: OHLCVBar[]): QuantAnalysis {
  const signals: QuantSignal[] = [
    rsiMeanReversion(bars),
    bollingerReversion(bars),
    momentumTrend(bars),
    volumeAnomaly(bars),
    volatilityState(bars),
    atrBreakout(bars),
  ];

  // 加重平均スコア（信頼度も加味、学習済みweightsを使用）
  let weightedSum = 0;
  let weightTotal = 0;
  for (const sig of signals) {
    if (sig.confidence > 0) {
      const w = (activeSignalWeights[sig.name] ?? 1.0) * (sig.confidence / 100);
      weightedSum += sig.score * w;
      weightTotal += w;
    }
  }

  const compositeScore = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  const compositeConfidence = signals.filter(s => s.confidence > 0).length / signals.length * 100;

  // 推奨判定
  let recommendation: QuantAnalysis["recommendation"];
  if (compositeScore >= 50) recommendation = "STRONG_BUY";
  else if (compositeScore >= 20) recommendation = "BUY";
  else if (compositeScore <= -50) recommendation = "STRONG_SELL";
  else if (compositeScore <= -20) recommendation = "SELL";
  else recommendation = "HOLD";

  // 主要な根拠を収集
  const reasons = signals
    .filter(s => Math.abs(s.score) >= 20 && s.confidence > 30)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .map(s => `[${s.name}] ${s.reason}`);

  return {
    signals,
    compositeScore,
    compositeConfidence,
    recommendation,
    reasons,
  };
}
