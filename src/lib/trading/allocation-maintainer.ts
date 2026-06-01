/**
 * Allocation maintainer (Wealth Navi / SBI AI Wrap 風 動的配分):
 *
 * 静的 target (15-20%) ではなく、市場状況 (F&G、ドローダウン、ボラ、トレンド) に
 * 応じて目標現金比率を動的計算。BUY のみ実行 (1 週間最低保有制約のため SELL はしない)。
 *
 * 設計:
 * - 毎 N cycle に 1 回チェック (毎サイクルではない)
 * - 動的 target_cash% を computeDynamicTargetCashRatio で算出 (10-50%)
 * - 現金比率 > target + 5% なら小額の BUY を実行
 * - 対象ペア: quant composite score が最も高いペア (全 pair で 0 以上のもの)
 * - 金額: 動的 (¥2,000-¥5,000、現金 buffer 大きいほど大きく)
 * - 安全弁:
 *   - kill switch 発火中は skip
 *   - daily loss 既に -1.5% 超なら skip
 *   - 直近 24h 累積で 5 回までの allocation BUY に制限
 */

import { loadData, saveData } from "../data";

/** 最小現金比率 (動的 target がこれ以下にならないように) */
export const ALLOC_TARGET_CASH_FLOOR = 0.10;
/** 最大現金比率 (動的 target がこれ以上にならないように) */
export const ALLOC_TARGET_CASH_CEIL = 0.50;
/** ベース現金比率 (中立市場) */
export const ALLOC_BASE_CASH_RATIO = 0.20;
/** target を超える buffer がこれ以上なら allocation BUY 発動 */
export const ALLOC_TRIGGER_BUFFER = 0.05;
/** allocation BUY の最小・最大金額 (BitFlyer 最小注文 + BTC 0.001 = ~¥11,700 をカバー) */
const ALLOC_BUY_MIN_JPY = 12000;
const ALLOC_BUY_MAX_JPY = 30000;
/** 24h 内の最大 allocation BUY 回数 */
const ALLOC_MAX_PER_DAY = 5;
/** daily loss これ以下なら allocation 停止 (resp risk) */
const DAILY_LOSS_PERCENT_STOP = -1.5;

/**
 * Wealth Navi / robo-advisor 風の動的 target cash ratio 計算。
 * 市場が攻めやすい (恐怖・安定) なら現金少なく、危険 (バブル・高ボラ・ドローダウン中) なら現金多く。
 *
 * @returns 目標現金比率 (0.10 - 0.50)
 */
export function computeDynamicTargetCashRatio(input: {
  fearGreed: number;         // 0-100
  ndDrawdownPct: number;     // peak からの現 NAV drawdown % (正値で表現、例: 5 = -5%)
  btcAtrPercent: number;     // BTC ATR / 価格 * 100
  btcTrendBullish: boolean;  // SMA20 > SMA50 なら true
}): { target: number; breakdown: Record<string, number>; reason: string } {
  const breakdown: Record<string, number> = {};
  let target = ALLOC_BASE_CASH_RATIO;
  breakdown.base = ALLOC_BASE_CASH_RATIO;

  // F&G による調整: バブル域は defensive、恐怖域は opportunity
  let fngAdj = 0;
  if (input.fearGreed >= 80) fngAdj = 0.15;       // extreme greed → 大幅増 cash
  else if (input.fearGreed >= 70) fngAdj = 0.08;  // greed → 増 cash
  else if (input.fearGreed <= 20) fngAdj = -0.05; // extreme fear → 減 cash (買い場)
  else if (input.fearGreed <= 30) fngAdj = -0.03; // fear → わずか減
  target += fngAdj;
  breakdown.fng = fngAdj;

  // Drawdown による調整: 損失中は cooling
  let ddAdj = 0;
  if (input.ndDrawdownPct >= 5) {
    // 5% drawdown = +5%, 10% = +10%, cap at +15%
    ddAdj = Math.min(0.15, Math.floor(input.ndDrawdownPct / 5) * 0.05);
  }
  target += ddAdj;
  breakdown.drawdown = ddAdj;

  // ボラティリティによる調整: 高ボラ = defensive
  let volAdj = 0;
  if (input.btcAtrPercent >= 6) volAdj = 0.10;
  else if (input.btcAtrPercent >= 4) volAdj = 0.05;
  else if (input.btcAtrPercent <= 1.5) volAdj = -0.02; // 静かな市場は若干 offensive
  target += volAdj;
  breakdown.volatility = volAdj;

  // トレンドによる調整: bearish なら defensive
  const trendAdj = input.btcTrendBullish ? -0.03 : 0.05;
  target += trendAdj;
  breakdown.trend = trendAdj;

  // クランプ
  const clamped = Math.max(ALLOC_TARGET_CASH_FLOOR, Math.min(ALLOC_TARGET_CASH_CEIL, target));

  const reason = `base ${(ALLOC_BASE_CASH_RATIO * 100).toFixed(0)}% ${fngAdj >= 0 ? "+" : ""}${(fngAdj * 100).toFixed(0)}% (F&G ${input.fearGreed}) ${ddAdj >= 0 ? "+" : ""}${(ddAdj * 100).toFixed(0)}% (DD ${input.ndDrawdownPct.toFixed(1)}%) ${volAdj >= 0 ? "+" : ""}${(volAdj * 100).toFixed(0)}% (ATR ${input.btcAtrPercent.toFixed(1)}%) ${trendAdj >= 0 ? "+" : ""}${(trendAdj * 100).toFixed(0)}% (${input.btcTrendBullish ? "bull" : "bear"}) → ${(clamped * 100).toFixed(0)}%`;

  return { target: clamped, breakdown, reason };
}

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
    targetCashRatio: number;
    targetReason: string;
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
  /** Wealth Navi 風動的 target 計算用 */
  navDrawdownPct: number;       // peak からの drawdown % (正値)
  btcAtrPercent: number;        // BTC ATR / 価格 * 100
  btcTrendBullish: boolean;     // SMA20 > SMA50
  /** AI 駆動の target override (cash %, 0-1)。指定された場合はルールベースを上書き */
  aiTargetCashRatio?: number;
  aiTargetReason?: string;
  aiTargetSource?: "ai" | "fallback";
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

  // === target 計算: AI 駆動 (優先) or ルールベース (fallback) ===
  const dyn = computeDynamicTargetCashRatio({
    fearGreed: input.fearGreed,
    ndDrawdownPct: input.navDrawdownPct,
    btcAtrPercent: input.btcAtrPercent,
    btcTrendBullish: input.btcTrendBullish,
  });
  const targetCashRatio = input.aiTargetCashRatio !== undefined
    ? Math.max(ALLOC_TARGET_CASH_FLOOR, Math.min(ALLOC_TARGET_CASH_CEIL, input.aiTargetCashRatio))
    : dyn.target;
  const targetReason = input.aiTargetCashRatio !== undefined
    ? `[AI ${input.aiTargetSource ?? "ai"}] ${input.aiTargetReason ?? "AI judgment"} (rule参考: ${dyn.reason})`
    : dyn.reason;
  const triggerCashRatio = targetCashRatio + ALLOC_TRIGGER_BUFFER;

  const diagnostics = {
    cashRatio,
    cryptoRatio,
    targetCashRatio,
    targetReason,
    totalJPY: total,
    jpyFreeJPY: input.jpyFree,
    triggered: cashRatio > triggerCashRatio,
  };

  if (!diagnostics.triggered) {
    return {
      shouldBuy: false,
      reason: `現金比率 ${(cashRatio * 100).toFixed(1)}% <= 動的 target ${(targetCashRatio * 100).toFixed(0)}% + buffer ${(ALLOC_TRIGGER_BUFFER * 100).toFixed(0)}%、allocation 不要`,
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

  // 過剰買い防止
  const recent = await getRecentHistory();
  if (recent.length >= ALLOC_MAX_PER_DAY) {
    return {
      shouldBuy: false,
      reason: `24h 内に既に ${recent.length} 回 allocation 実行済 (上限 ${ALLOC_MAX_PER_DAY})`,
      diagnostics,
    };
  }

  // 動的金額: 現金 buffer が大きいほど大きく買う (ただし上限あり)
  const cashBufferJPY = (cashRatio - targetCashRatio) * total;
  // buffer の 30% を 1 回で消化 (10 回くらいで target に近づく設計)
  const amountJPY = Math.min(ALLOC_BUY_MAX_JPY, Math.max(ALLOC_BUY_MIN_JPY, Math.floor(cashBufferJPY * 0.30 / 100) * 100));

  // 現金不足
  if (input.jpyFree < amountJPY) {
    return {
      shouldBuy: false,
      reason: `JPY 残高 ¥${Math.round(input.jpyFree).toLocaleString()} < 必要額 ¥${amountJPY.toLocaleString()}`,
      diagnostics,
    };
  }

  // ペア選定: composite score が最も高いペア (0 以上) かつ amount で発注可能なペア
  // BitFlyer 最小注文 (BTC 0.001 = 約 ¥11,700) を満たせないペアは候補から除外
  const candidates = input.pairScores.filter(p => {
    if (p.compositeScore < 0 || p.price <= 0) return false;
    // ペアごとの最小発注 JPY を概算 (BTC 0.001, ETH 0.01, XRP/XLM/MONA 0.1 想定)
    const base = p.pair.split("/")[0];
    const minBase: Record<string, number> = { BTC: 0.001, ETH: 0.01, XRP: 0.1, XLM: 0.1, MONA: 0.1, BCH: 0.001 };
    const minJPY = Math.ceil((minBase[base] ?? 0.001) * p.price * 1.1);
    return amountJPY >= minJPY;
  });
  if (candidates.length === 0) {
    return {
      shouldBuy: false,
      reason: `候補なし: ¥${amountJPY.toLocaleString()} で発注可能かつ composite score >= 0 のペアなし (BTC は ~¥11,700+ 必要)`,
      diagnostics,
    };
  }
  const best = candidates.sort((a, b) => b.compositeScore - a.compositeScore)[0];

  return {
    shouldBuy: true,
    pair: best.pair,
    amountJPY,
    reason: `現金比率 ${(cashRatio * 100).toFixed(1)}% > 動的target ${(targetCashRatio * 100).toFixed(0)}%+buffer → ${best.pair} (score ${best.compositeScore}) を ¥${amountJPY.toLocaleString()} allocation BUY [${dyn.reason}]`,
    diagnostics,
  };
}
