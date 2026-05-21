/**
 * タイミング検出強化: 底打ち / 天井のマルチソース合議
 *
 * 通常の scoring engine は trend-follow 寄りで、TRENDING_DOWN regime で
 * BUY を出さない。だが「ここが底」と判定できれば押し目買い (counter-trend) で
 * 利益機会を逃さない。
 *
 * 哲学: 1 つのシグナルで動くな、複数ソースが揃った時だけ override する。
 */

import type { OHLCVBar } from "../types";
import { rsi } from "../indicators";
import type { ExternalBias } from "../external/investment-app";

export interface TimingOpportunity {
  /** override で発火させるか */
  fire: boolean;
  type: "BOTTOM_BUY" | "TOP_SELL" | null;
  /** 0-100 */
  confidence: number;
  /** 揃った条件のリスト */
  conditions: string[];
  /** 不足してる条件 (デバッグ用) */
  missing: string[];
}

interface DetectInput {
  bars: OHLCVBar[];
  cryptoFearGreed: number;     // 0-100
  externalBias: ExternalBias | null;
  /** 現在価格 */
  price: number;
}

const NULL_OPPORTUNITY: TimingOpportunity = { fire: false, type: null, confidence: 0, conditions: [], missing: [] };

/**
 * 段階的 反転検出 (積極版).
 * 既存 detectBottomOpportunity は extreme 条件 (F&G≤25 必須等) で厳しすぎ。
 * これは「下げ止まり初期サイン」を低い閾値で検出して entry チャンス増やす。
 *
 * 5 条件 多段判定:
 *  1. 直近 6本 で -1.5% 以上の下落あった (底候補形成)
 *  2. 直近 3本 のうち 1+ 陽線、または最後の low が前 low より高い (higher low)
 *  3. 直近 1本 の volume が直近 10本平均の 1.2倍以上 (反発出来高)
 *  4. RSI が直近 6本でボトムから 5pt 以上回復 (反発兆候)
 *  5. 価格が直近 6本の安値の +1.5% 以内 (まだ底圏)
 *
 *  3/5 → confidence 65 (小さく試す)
 *  4/5 → confidence 78 (通常)
 *  5/5 → confidence 88 (確信)
 */
export function detectAggressiveReversal(input: DetectInput): TimingOpportunity {
  const { bars, price } = input;
  if (bars.length < 30) return NULL_OPPORTUNITY;

  const conditions: string[] = [];
  const missing: string[] = [];

  const last6 = bars.slice(-6);
  const last3 = bars.slice(-3);

  // 条件1: 直近 6本 で -1.5% 以上下落あった
  const high6 = Math.max(...last6.map(b => b.high));
  const low6 = Math.min(...last6.map(b => b.low));
  const drop6 = high6 > 0 ? ((high6 - low6) / high6) * 100 : 0;
  if (drop6 >= 1.5) {
    conditions.push(`直近6本で -${drop6.toFixed(1)}% 下落 (底候補)`);
  } else {
    missing.push(`下落 ${drop6.toFixed(1)}% < 1.5%`);
  }

  // 条件2: higher low or 陽線
  const greenBars3 = last3.filter(b => b.close > b.open).length;
  const lastLow = last3[last3.length - 1].low;
  const prevLow = last3.length >= 2 ? last3[last3.length - 2].low : lastLow;
  const isHigherLow = lastLow > prevLow;
  if (greenBars3 >= 1 || isHigherLow) {
    conditions.push(`反発: ${greenBars3 >= 1 ? `陽線 ${greenBars3}/3` : `higher low`}`);
  } else {
    missing.push(`陽線 ${greenBars3}/3 + 安値更新`);
  }

  // 条件3: 直近1本の volume が平均の 1.2倍以上 (反発出来高)
  const last10Volume = bars.slice(-10).map(b => b.volume).filter(v => v > 0);
  const avgVol = last10Volume.length > 0 ? last10Volume.reduce((s, v) => s + v, 0) / last10Volume.length : 0;
  const lastVol = bars[bars.length - 1].volume;
  if (avgVol > 0 && lastVol > avgVol * 1.2) {
    conditions.push(`出来高 ${(lastVol / avgVol).toFixed(1)}x (反発確認)`);
  } else {
    missing.push(`出来高 ${avgVol > 0 ? (lastVol / avgVol).toFixed(1) : "0"}x < 1.2x`);
  }

  // 条件4: RSI 反発
  const rsiVals = rsi(bars.map(b => b.close), 14).filter((v): v is number => v != null);
  if (rsiVals.length >= 6) {
    const recent6Rsi = rsiVals.slice(-6);
    const minRsi = Math.min(...recent6Rsi);
    const lastRsi = recent6Rsi[recent6Rsi.length - 1];
    if (lastRsi - minRsi >= 5) {
      conditions.push(`RSI ${minRsi.toFixed(0)} → ${lastRsi.toFixed(0)} 反発`);
    } else {
      missing.push(`RSI 反発 ${(lastRsi - minRsi).toFixed(1)}pt < 5pt`);
    }
  }

  // 条件5: まだ底圏 (安値から +1.5% 以内)
  if (price > 0 && low6 > 0 && (price - low6) / low6 < 0.015) {
    conditions.push(`底圏 +${(((price - low6) / low6) * 100).toFixed(1)}% (低値から近い)`);
  } else {
    missing.push(`底圏外 +${low6 > 0 ? (((price - low6) / low6) * 100).toFixed(1) : "?"}% > 1.5%`);
  }

  const hits = conditions.length;
  let fire = false;
  let confidence = 0;
  if (hits >= 5) { fire = true; confidence = 88; }
  else if (hits >= 4) { fire = true; confidence = 78; }
  else if (hits >= 3) { fire = true; confidence = 65; }

  return {
    fire,
    type: fire ? "BOTTOM_BUY" : null,
    confidence,
    conditions,
    missing,
  };
}

/**
 * 底打ち検出: 売られすぎが複数ソースで確認できたら BUY 強制発火
 *
 * 4 条件中 3 つ以上 揃えば発火 (1-2 つだと過剰反応リスク)
 */
export function detectBottomOpportunity(input: DetectInput): TimingOpportunity {
  const { bars, cryptoFearGreed, externalBias, price } = input;
  if (bars.length < 30) return NULL_OPPORTUNITY;

  const conditions: string[] = [];
  const missing: string[] = [];

  // 条件1: RSI 売られすぎ (< 30)
  const rsiVals = rsi(bars.map(b => b.close), 14);
  const lastRSI = rsiVals.filter((v): v is number => v != null).slice(-1)[0];
  if (lastRSI != null && lastRSI < 30) {
    conditions.push(`RSI ${lastRSI.toFixed(1)} 売られすぎ`);
  } else {
    missing.push(`RSI ${lastRSI?.toFixed(1) ?? "N/A"} ≥ 30`);
  }

  // 条件2: 直近 14 期間 安値の +1% 以内 (サポート接近)
  const recent14 = bars.slice(-14);
  const lowestLow = Math.min(...recent14.map(b => b.low));
  if (price > 0 && lowestLow > 0 && (price - lowestLow) / lowestLow < 0.01) {
    conditions.push(`安値圏 ¥${price.toFixed(0)} ≤ 14期間安値+1% (¥${lowestLow.toFixed(0)})`);
  } else {
    missing.push(`安値圏外 (現在 ¥${price.toFixed(0)} vs 14期間安値 ¥${lowestLow.toFixed(0)})`);
  }

  // 条件3: F&G 極度恐怖 (≤ 25)
  // 暗号通貨 F&G 優先、無ければ株式 F&G で代用
  const stocksFG = externalBias?.components.find(c => c.name === "株式F&G");
  if (cryptoFearGreed <= 25) {
    conditions.push(`crypto F&G ${cryptoFearGreed} 極度恐怖`);
  } else if (stocksFG && stocksFG.score > 0) {
    // stocksFG.score > 0 = stocks F&G が低かった (BUY bias を作った)
    conditions.push(`株式 F&G 連動: ${stocksFG.reason}`);
  } else {
    missing.push(`F&G crypto:${cryptoFearGreed} > 25, 株式中立`);
  }

  // 条件4: 反転兆候 (直近 3 本のうち 2 本以上が陽線、または下落速度減速)
  const last3 = bars.slice(-3);
  const greenBars = last3.filter(b => b.close > b.open).length;
  const last5 = bars.slice(-5);
  const declineSpeed = last5.length >= 5 ? Math.abs(last5[4].close - last5[0].close) / last5[0].close : 0;
  const last10 = bars.slice(-10);
  const earlyDeclineSpeed = last10.length >= 10 ? Math.abs(last10[4].close - last10[0].close) / last10[0].close : 0;
  if (greenBars >= 2 || (declineSpeed > 0 && earlyDeclineSpeed > declineSpeed * 1.5)) {
    conditions.push(`反転兆候 (陽線${greenBars}/3 or 下落速度減速)`);
  } else {
    missing.push(`陽線 ${greenBars}/3 + 下落継続中`);
  }

  // 4 条件中 3 以上 → 発火
  const fire = conditions.length >= 3;
  const confidence = Math.min(95, 50 + conditions.length * 12);

  return {
    fire,
    type: fire ? "BOTTOM_BUY" : null,
    confidence: fire ? confidence : 0,
    conditions,
    missing,
  };
}

/**
 * 天井検出: 買われすぎ + 過熱で SELL 強制発火 (利確タイミング)
 *
 * 既に持ってるポジションを天井で売らせる用途。
 * 4 条件中 3 つ以上 揃えば発火
 */
export function detectTopOpportunity(input: DetectInput): TimingOpportunity {
  const { bars, cryptoFearGreed, externalBias, price } = input;
  if (bars.length < 30) return NULL_OPPORTUNITY;

  const conditions: string[] = [];
  const missing: string[] = [];

  // 条件1: RSI 買われすぎ (> 75)
  const rsiVals = rsi(bars.map(b => b.close), 14);
  const lastRSI = rsiVals.filter((v): v is number => v != null).slice(-1)[0];
  if (lastRSI != null && lastRSI > 75) {
    conditions.push(`RSI ${lastRSI.toFixed(1)} 買われすぎ`);
  } else {
    missing.push(`RSI ${lastRSI?.toFixed(1) ?? "N/A"} ≤ 75`);
  }

  // 条件2: 直近 14 期間 高値の -1% 以内 (レジスタンス接近)
  const recent14 = bars.slice(-14);
  const highestHigh = Math.max(...recent14.map(b => b.high));
  if (price > 0 && highestHigh > 0 && (highestHigh - price) / highestHigh < 0.01) {
    conditions.push(`高値圏 ¥${price.toFixed(0)} ≥ 14期間高値-1% (¥${highestHigh.toFixed(0)})`);
  } else {
    missing.push(`高値圏外 (現在 ¥${price.toFixed(0)} vs 14期間高値 ¥${highestHigh.toFixed(0)})`);
  }

  // 条件3: F&G 極度貪欲 (≥ 75)
  const stocksFG = externalBias?.components.find(c => c.name === "株式F&G");
  if (cryptoFearGreed >= 75) {
    conditions.push(`crypto F&G ${cryptoFearGreed} 極度貪欲`);
  } else if (stocksFG && stocksFG.score < 0) {
    conditions.push(`株式 F&G 連動: ${stocksFG.reason}`);
  } else {
    missing.push(`F&G crypto:${cryptoFearGreed} < 75, 株式中立`);
  }

  // 条件4: 上昇減速 (上ヒゲ多発、または直近 3 本のうち 2 本以上が陰線)
  const last3 = bars.slice(-3);
  const redBars = last3.filter(b => b.close < b.open).length;
  const upperWickRatio = last3.length > 0
    ? last3.reduce((s, b) => s + (b.high - Math.max(b.open, b.close)) / Math.max(0.001, b.high - b.low), 0) / last3.length
    : 0;
  if (redBars >= 2 || upperWickRatio > 0.5) {
    conditions.push(`上昇減速 (陰線${redBars}/3 or 上ヒゲ${(upperWickRatio * 100).toFixed(0)}%)`);
  } else {
    missing.push(`陰線 ${redBars}/3 + 強気継続中`);
  }

  // 4 条件中 3 以上 → 発火
  const fire = conditions.length >= 3;
  const confidence = Math.min(95, 50 + conditions.length * 12);

  return {
    fire,
    type: fire ? "TOP_SELL" : null,
    confidence: fire ? confidence : 0,
    conditions,
    missing,
  };
}
