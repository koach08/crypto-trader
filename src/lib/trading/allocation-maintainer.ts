/**
 * Allocation maintainer: target 暗号比率を維持するための受動的 BUY。
 *
 * 問題: bot は AI シグナル発火時にしか BUY しない設計のため、損失で JPY が
 * 戻ると現金比率が target (15-20%) を遥かに超えても放置されていた。
 * 「AI trader として何のためにあるのか」という指摘に対応。
 *
 * 設計:
 * - 毎 N cycle に 1 回チェック (毎サイクルではない、AI トレードを邪魔しない)
 * - 現金比率 > target_max (25%) なら小額の BUY を実行
 * - 対象ペア: quant composite score が最も高いペア (全 pair で 0 以上のもの)
 * - 金額: 固定 ¥2,000 (誤判定でも被害最小化)
 * - 安全弁:
 *   - kill switch 発火中は skip
 *   - daily loss 既に -1.5% 超なら skip
 *   - Fear & Greed < 15 (パニック暴落) または > 90 (バブル) は skip
 *   - 直近 24h 累積で 5 回までの allocation BUY に制限
 */

import { loadData, saveData } from "../data";

export const ALLOC_TARGET_CASH_MIN = 0.15;
export const ALLOC_TARGET_CASH_MAX = 0.20;
/** これより現金比率が高いと allocation BUY を発動 */
export const ALLOC_TRIGGER_CASH_RATIO = 0.25;
/** 1 回の allocation BUY 金額 */
export const ALLOC_BUY_JPY = 2000;
/** 24h 内の最大 allocation BUY 回数 */
const ALLOC_MAX_PER_DAY = 5;
/** Fear & Greed の安全範囲 */
const FNG_SAFE_MIN = 15;
const FNG_SAFE_MAX = 90;
/** daily loss これ以下なら allocation 停止 (resp risk) */
const DAILY_LOSS_PERCENT_STOP = -1.5;

const HISTORY_FILE = "allocation-history";

interface AllocationEvent {
  timestamp: string;
  pair: string;
  amountJPY: number;
  price: number;
  reason: string;
}

export interface AllocationDecision {
  shouldBuy: boolean;
  pair?: string;
  amountJPY?: number;
  reason: string;
  /** 現状診断 */
  diagnostics: {
    cashRatio: number;
    cryptoRatio: number;
    totalJPY: number;
    jpyFreeJPY: number;
    triggered: boolean;
  };
}

export interface AllocationInput {
  jpyFree: number;
  cryptoValueJPY: number;
  fearGreed: number;
  dailyPnLPercent: number;
  killSwitchActive: boolean;
  /** 候補ペアと composite score (高いほど買いたい) */
  pairScores: { pair: string; compositeScore: number; price: number }[];
}

async function getRecentHistory(): Promise<AllocationEvent[]> {
  const all = await loadData<AllocationEvent[]>(HISTORY_FILE, []);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return all.filter(e => new Date(e.timestamp).getTime() >= cutoff);
}

export async function recordAllocationEvent(event: AllocationEvent): Promise<void> {
  const all = await loadData<AllocationEvent[]>(HISTORY_FILE, []);
  all.push(event);
  // 保持は直近 100 件まで
  await saveData(HISTORY_FILE, all.slice(-100));
}

export async function evaluateAllocation(input: AllocationInput): Promise<AllocationDecision> {
  const total = input.jpyFree + input.cryptoValueJPY;
  const cashRatio = total > 0 ? input.jpyFree / total : 1;
  const cryptoRatio = 1 - cashRatio;
  const diagnostics = {
    cashRatio,
    cryptoRatio,
    totalJPY: total,
    jpyFreeJPY: input.jpyFree,
    triggered: cashRatio > ALLOC_TRIGGER_CASH_RATIO,
  };

  if (!diagnostics.triggered) {
    return {
      shouldBuy: false,
      reason: `現金比率 ${(cashRatio * 100).toFixed(1)}% <= trigger ${ALLOC_TRIGGER_CASH_RATIO * 100}%、allocation 不要`,
      diagnostics,
    };
  }

  // 安全弁チェック
  if (input.killSwitchActive) {
    return { shouldBuy: false, reason: "kill switch 発火中、allocation 停止", diagnostics };
  }
  if (input.dailyPnLPercent <= DAILY_LOSS_PERCENT_STOP) {
    return {
      shouldBuy: false,
      reason: `日次損失 ${input.dailyPnLPercent.toFixed(2)}% <= ${DAILY_LOSS_PERCENT_STOP}%、allocation 停止`,
      diagnostics,
    };
  }
  if (input.fearGreed < FNG_SAFE_MIN || input.fearGreed > FNG_SAFE_MAX) {
    return {
      shouldBuy: false,
      reason: `F&G ${input.fearGreed} が安全範囲 [${FNG_SAFE_MIN}-${FNG_SAFE_MAX}] 外、allocation 停止 (パニック/バブル警戒)`,
      diagnostics,
    };
  }

  // 過剰買い防止
  const recent = await getRecentHistory();
  if (recent.length >= ALLOC_MAX_PER_DAY) {
    return {
      shouldBuy: false,
      reason: `24h 内に既に ${recent.length} 回 allocation 実行済 (上限 ${ALLOC_MAX_PER_DAY})`,
      diagnostics,
    };
  }

  // 現金不足
  if (input.jpyFree < ALLOC_BUY_JPY) {
    return {
      shouldBuy: false,
      reason: `JPY 残高 ¥${Math.round(input.jpyFree).toLocaleString()} < 必要額 ¥${ALLOC_BUY_JPY.toLocaleString()}`,
      diagnostics,
    };
  }

  // ペア選定: composite score が最も高いペア (0 以上)
  const candidates = input.pairScores.filter(p => p.compositeScore >= 0 && p.price > 0);
  if (candidates.length === 0) {
    return {
      shouldBuy: false,
      reason: "全ペアで composite score < 0、allocation BUY する妥当なペアなし",
      diagnostics,
    };
  }
  const best = candidates.sort((a, b) => b.compositeScore - a.compositeScore)[0];

  return {
    shouldBuy: true,
    pair: best.pair,
    amountJPY: ALLOC_BUY_JPY,
    reason: `現金比率 ${(cashRatio * 100).toFixed(1)}% (target ${ALLOC_TARGET_CASH_MAX * 100}%以下) → ${best.pair} (score ${best.compositeScore}) を ¥${ALLOC_BUY_JPY.toLocaleString()} allocation BUY`,
    diagnostics,
  };
}
