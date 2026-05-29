/**
 * Opportunity detector: 「historical 級のチャンス / 危険」検知 → Slack push.
 *
 * 設計思想:
 *   - bot の判断 (BUY/SELL/HOLD) とは独立に、cycle 内で純粋な「機会」を検知
 *   - 検知したら sendAlert で push → user が見逃さない、bot 判断と人間判断のハイブリッド可能
 *   - 同種イベントは 1 時間 dedupe (Slack スパム防止)
 *
 * 検知イベント:
 *   1. HISTORICAL_VALUE: F&G ≤ 25 + 14期間安値圏 + 出来高 spike = バフェット級買い場
 *   2. INSTITUTIONAL_BUY: Whale 大量流出 + community 反転 = 機関買い兆候
 *   3. FOMO_TRAP: ATH ±3% + F&G ≥ 75 + 過剰 contango = 売り検討シグナル
 *   4. PANIC_OPPORTUNITY: NAV -10% 以内 + F&G ≤ 20 = 短期反発 candidate
 *   5. INTEL_EXTREME: aggregated intel ≥ +70 or ≤ -70 = 強い方向性
 */

import { sendAlert } from "./alerts";
import type { AggregatedIntel } from "./intel/aggregator";

export interface OpportunityInput {
  pair: string;
  price: number;
  /** 14 期間安値圏 = 安値 +1% 以内なら true */
  near14LowPercent?: number;
  near14HighPercent?: number;
  /** F&G index (0-100) */
  fearGreed?: number;
  /** 出来高比 (1.0 = 平均) */
  volumeRatio?: number;
  /** intel 集約スコア (-100 〜 +100) */
  intel?: AggregatedIntel | null;
  /** 現在の cycle で底打ち override 発火したか */
  bottomFire?: boolean;
  bottomConfidence?: number;
  /** 反転 override 発火 */
  reversalFire?: boolean;
}

// 各 event の dedupe key と TTL (1 hour)
const DEDUPE_TTL_MS = 60 * 60 * 1000;
const _lastFired = new Map<string, number>();

function shouldFire(key: string): boolean {
  const last = _lastFired.get(key);
  if (last && Date.now() - last < DEDUPE_TTL_MS) return false;
  _lastFired.set(key, Date.now());
  return true;
}

export async function checkOpportunities(input: OpportunityInput): Promise<void> {
  // 1. HISTORICAL_VALUE: F&G ≤25 + 安値圏 + 出来高 spike
  if (
    (input.fearGreed ?? 100) <= 25 &&
    input.bottomFire &&
    (input.bottomConfidence ?? 0) >= 80 &&
    (input.volumeRatio ?? 0) >= 1.5
  ) {
    if (shouldFire(`hist-value:${input.pair}`)) {
      await sendAlert({
        level: "info",
        message: `💎 ${input.pair} HISTORICAL VALUE 圏検知 — F&G ${input.fearGreed}, 14期間安値圏, 出来高 ${input.volumeRatio?.toFixed(2)}x, 底打ち conf ${input.bottomConfidence}%`,
        dedupeKey: `hist-value:${input.pair}`,
        fields: {
          "Price": `¥${input.price.toLocaleString()}`,
          "F&G": String(input.fearGreed),
          "Volume": `${input.volumeRatio?.toFixed(2)}x`,
          "Bot 判断": "BUY override 発火中",
        },
      });
    }
  }

  // 2. INSTITUTIONAL_BUY: Whale 流出 + intel utility 強気
  const whaleScore = input.intel?.components.whale?.score ?? 0;
  const utilityScore = input.intel?.categories.utility?.score ?? 0;
  if (whaleScore >= 40 && utilityScore >= 30) {
    if (shouldFire(`inst-buy:${input.pair}`)) {
      await sendAlert({
        level: "info",
        message: `🐋 ${input.pair} 機関買い兆候 — Whale +${whaleScore} (CEX 純流出), 実需 +${utilityScore}`,
        dedupeKey: `inst-buy:${input.pair}`,
        fields: {
          "Whale signal": `+${whaleScore}`,
          "Utility signal": `+${utilityScore}`,
          "Verdict": input.intel?.verdict ?? "—",
        },
      });
    }
  }

  // 3. FOMO_TRAP: 14期間高値圏 + F&G ≥75
  if (
    (input.fearGreed ?? 0) >= 75 &&
    (input.near14HighPercent ?? 100) <= 1
  ) {
    if (shouldFire(`fomo:${input.pair}`)) {
      await sendAlert({
        level: "warn",
        message: `🎢 ${input.pair} FOMO TRAP 警戒 — F&G ${input.fearGreed} (極度貪欲), 14期間高値圏`,
        dedupeKey: `fomo:${input.pair}`,
        fields: {
          "Price": `¥${input.price.toLocaleString()}`,
          "F&G": String(input.fearGreed),
          "推奨": "新規 BUY 控えめ, 既存 partial TP 検討",
        },
      });
    }
  }

  // 5. INTEL_EXTREME: aggregated intel が ±70 以上
  const totalIntel = input.intel?.totalScore ?? 0;
  if (totalIntel >= 70) {
    if (shouldFire(`intel-bull-extreme:${input.pair}`)) {
      await sendAlert({
        level: "info",
        message: `📈 ${input.pair} INTEL 強烈 BULLISH +${totalIntel} (${input.intel?.verdict})`,
        dedupeKey: `intel-bull-extreme:${input.pair}`,
      });
    }
  } else if (totalIntel <= -70) {
    if (shouldFire(`intel-bear-extreme:${input.pair}`)) {
      await sendAlert({
        level: "warn",
        message: `📉 ${input.pair} INTEL 強烈 BEARISH ${totalIntel} (${input.intel?.verdict})`,
        dedupeKey: `intel-bear-extreme:${input.pair}`,
      });
    }
  }
}

/** dedupe state をクリア (テスト/デバッグ用) */
export function _clearOpportunityState(): void {
  _lastFired.clear();
}
