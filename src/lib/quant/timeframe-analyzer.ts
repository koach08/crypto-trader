/**
 * 短期/中期/長期 マルチタイムフレーム分析.
 *
 * 既存 bot は 1h bars のみで判断。これは「短期」のみ。
 * 「今 安いから仕込む (底値拾い)」を実現するには長期の視点必要：
 *   - 長期 (90日以上) で見て「歴史的に安い」か
 *   - 中期 (1-2週間) で「反転兆候」あるか
 *   - 短期 (数時間) で「確認シグナル」出てるか
 *
 * 3 タイムフレーム合議で "STRONG_BUY" / "STRONG_SELL" を出す.
 */

import type { OHLCVBar } from "../types";
import { rsi, sma, atr } from "../indicators";

export interface TimeframeView {
  /** -100 (極端に売られ過ぎ/反発候補) 〜 +100 (極端に買われ過ぎ) */
  score: number;
  /** ラベル */
  label: "DEEP_VALUE" | "VALUE" | "FAIR" | "PRICEY" | "OVERVALUED";
  /** 詳細指標 */
  details: {
    priceVsSMA: number;        // 現在価格 / SMA - 1 (%)
    rsi: number | null;
    distanceFrom52wLow: number; // %
    distanceFrom52wHigh: number; // %
  };
  reason: string;
}

export interface MultiTimeframeAnalysis {
  short: TimeframeView;   // 数時間〜1日 (1h bars × 24)
  medium: TimeframeView;  // 1-2週間 (4h bars × 84 = 14日)
  long: TimeframeView;    // 1-3ヶ月 (1d bars × 90)
  /** 3 つ合わせた最終判定 */
  consensus: "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
  /** 「底値仕込み」シグナル: 長期 DEEP_VALUE + 中期 VALUE/FAIR + 短期反発 */
  bottomFishing: boolean;
  /** 「天井利確」シグナル: 長期 OVERVALUED + 中期 PRICEY + 短期失速 */
  topTaking: boolean;
  reason: string;
}

function classify(score: number): TimeframeView["label"] {
  if (score <= -50) return "DEEP_VALUE";
  if (score <= -20) return "VALUE";
  if (score < 20) return "FAIR";
  if (score < 50) return "PRICEY";
  return "OVERVALUED";
}

/**
 * 1 つのタイムフレームを評価.
 * 安いほど -スコア (買いシグナル)、高いほど +スコア (売りシグナル).
 */
function analyzeTimeframe(bars: OHLCVBar[], smaWindow: number): TimeframeView {
  if (bars.length < smaWindow) {
    return {
      score: 0,
      label: "FAIR",
      details: { priceVsSMA: 0, rsi: null, distanceFrom52wLow: 0, distanceFrom52wHigh: 0 },
      reason: `データ不足 (${bars.length}/${smaWindow}本)`,
    };
  }

  const closes = bars.map(b => b.close);
  const lows = bars.map(b => b.low);
  const highs = bars.map(b => b.high);
  const currentPrice = closes[closes.length - 1];

  const smaVals = sma(closes, smaWindow);
  const lastSMA = smaVals.filter((v): v is number => v != null).slice(-1)[0];
  const priceVsSMA = lastSMA && lastSMA > 0 ? ((currentPrice - lastSMA) / lastSMA) * 100 : 0;

  const rsiVals = rsi(closes, 14);
  const lastRSI = rsiVals.filter((v): v is number => v != null).slice(-1)[0] ?? null;

  const periodLow = Math.min(...lows);
  const periodHigh = Math.max(...highs);
  const distanceFrom52wLow = periodLow > 0 ? ((currentPrice - periodLow) / periodLow) * 100 : 0;
  const distanceFrom52wHigh = periodHigh > 0 ? ((periodHigh - currentPrice) / periodHigh) * 100 : 0;

  // スコア計算 (multi-factor)
  // 1. SMA との乖離: 大きく下なら -、上なら +
  const smaScore = Math.max(-50, Math.min(50, priceVsSMA * 2)); // ±25% で max
  // 2. RSI: 30 以下で -50, 70 以上で +50
  const rsiScore = lastRSI != null
    ? Math.max(-50, Math.min(50, ((lastRSI ?? 50) - 50) * 2))
    : 0;
  // 3. 安値からの距離: 安値圏なら -、高値圏なら +
  const range = periodHigh - periodLow;
  const positionInRange = range > 0 ? (currentPrice - periodLow) / range : 0.5;
  const positionScore = (positionInRange - 0.5) * 100; // -50 (安値) 〜 +50 (高値)

  // 加重平均
  const score = Math.round(smaScore * 0.4 + rsiScore * 0.3 + positionScore * 0.3);
  const label = classify(score);

  let reason = `SMA ${priceVsSMA >= 0 ? "+" : ""}${priceVsSMA.toFixed(1)}% / RSI ${lastRSI?.toFixed(0) ?? "-"} / 安値+${distanceFrom52wLow.toFixed(1)}% 高値-${distanceFrom52wHigh.toFixed(1)}%`;

  return {
    score,
    label,
    details: {
      priceVsSMA: Math.round(priceVsSMA * 10) / 10,
      rsi: lastRSI != null ? Math.round(lastRSI) : null,
      distanceFrom52wLow: Math.round(distanceFrom52wLow * 10) / 10,
      distanceFrom52wHigh: Math.round(distanceFrom52wHigh * 10) / 10,
    },
    reason,
  };
}

export interface MTFInputs {
  /** 1h bars (短期、24本以上) */
  hourlyBars: OHLCVBar[];
  /** 4h bars (中期、84本以上 = 2週間) */
  fourHourBars: OHLCVBar[];
  /** 1d bars (長期、90本以上 = 3ヶ月) */
  dailyBars: OHLCVBar[];
}

export function analyzeMultiTimeframe(inputs: MTFInputs): MultiTimeframeAnalysis {
  const short = analyzeTimeframe(inputs.hourlyBars, 24);
  const medium = analyzeTimeframe(inputs.fourHourBars, 50);
  const long = analyzeTimeframe(inputs.dailyBars, 50);

  // === Consensus ===
  const avgScore = (short.score + medium.score + long.score) / 3;
  let consensus: MultiTimeframeAnalysis["consensus"];
  if (avgScore <= -40) consensus = "STRONG_BUY";
  else if (avgScore <= -15) consensus = "BUY";
  else if (avgScore < 15) consensus = "NEUTRAL";
  else if (avgScore < 40) consensus = "SELL";
  else consensus = "STRONG_SELL";

  // === 底値仕込みシグナル ===
  // 長期で DEEP_VALUE か VALUE (歴史的安値圏) AND 中期も下げ寄り (まだ反転待ち)
  // AND 短期で反発兆候 (RSI 上昇 or 安値からの距離 > 1%)
  const bottomFishing =
    (long.label === "DEEP_VALUE" || long.label === "VALUE") &&
    (medium.label === "DEEP_VALUE" || medium.label === "VALUE" || medium.label === "FAIR") &&
    short.score >= medium.score - 5; // 短期が中期より良くなってる = 反発兆候

  // === 天井利確シグナル ===
  const topTaking =
    (long.label === "OVERVALUED" || long.label === "PRICEY") &&
    (medium.label === "OVERVALUED" || medium.label === "PRICEY" || medium.label === "FAIR") &&
    short.score <= medium.score + 5; // 短期が中期より悪化 = 失速

  let reason = `[短期 ${short.label}/${short.score}] [中期 ${medium.label}/${medium.score}] [長期 ${long.label}/${long.score}] = ${consensus}`;
  if (bottomFishing) reason += " 🎯 底値仕込みチャンス";
  if (topTaking) reason += " 🔝 天井利確チャンス";

  return {
    short,
    medium,
    long,
    consensus,
    bottomFishing,
    topTaking,
    reason,
  };
}
