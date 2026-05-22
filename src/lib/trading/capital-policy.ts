/**
 * Capital policy: 「新入社員 → ベテラントレーダー」のキャリア成長で
 * 投入可能資金枠が広がるシステム.
 *
 * tier ごとに枠の上限/下限が決まり、AI (retrospective) はその枠内で
 * bufferPercent / convictionBoost を学習する.
 *
 * 「総資産」= JPY 残高 + 仮想通貨評価額 (NAV). 証券口座の株は別管理.
 *
 * 昇進条件:
 *   JUNIOR  → 0 取引から開始. 総資産の 50% まで投入可
 *   MID     → 30 取引 + WR50% + 累損益+ + maxDD<10%
 *   SENIOR  → 100 取引 + WR53% + Sharpe>0.8 + maxDD<8%
 *   MASTER  → 300 取引 + WR55% + Sharpe>1.2 + maxDD<6%
 *
 * 降格: maxDD が tier 閾値を 2 倍超えた、または WR が 5% 下回ったら 1 段下げる.
 */

import type { TradeRecord } from "../types";
import { loadData, saveData } from "../data";

export type CapitalTier = "JUNIOR" | "MID" | "SENIOR" | "MASTER";

export interface TierLimits {
  /** 投入可能資金の総資産に対する最大比率 (1.0 - bufferPercent/100) */
  maxDeployPercent: number;
  /** 現金として常時残す比率 */
  cashBufferPercent: number;
  /** 1 ペアあたりの投入総額に対する上限比率 */
  perPairMaxPercent: number;
  /** 強シグナル時の追加 boost 倍率上限 (AI が裁量で増減できる枠) */
  maxConvictionBoost: number;
  /** AI が retrospective で動かせる buffer の範囲 */
  bufferMinPercent: number;
  bufferMaxPercent: number;
}

/**
 * tier ごとの「枠」. AI はこの枠内でしか動かせない.
 * 上の tier ほど資金投入余地が大きい (= 自由度が高い).
 */
export const TIER_LIMITS: Record<CapitalTier, TierLimits> = {
  JUNIOR: {
    maxDeployPercent: 50,
    cashBufferPercent: 50,
    perPairMaxPercent: 35,
    maxConvictionBoost: 1.3,
    bufferMinPercent: 40,
    bufferMaxPercent: 65,
  },
  MID: {
    maxDeployPercent: 65,
    cashBufferPercent: 35,
    perPairMaxPercent: 45,
    maxConvictionBoost: 1.6,
    bufferMinPercent: 28,
    bufferMaxPercent: 50,
  },
  SENIOR: {
    maxDeployPercent: 75,
    cashBufferPercent: 25,
    perPairMaxPercent: 50,
    maxConvictionBoost: 2.0,
    bufferMinPercent: 20,
    bufferMaxPercent: 40,
  },
  MASTER: {
    maxDeployPercent: 90,
    cashBufferPercent: 10,
    perPairMaxPercent: 60,
    maxConvictionBoost: 2.5,
    bufferMinPercent: 8,
    bufferMaxPercent: 25,
  },
};

export interface CapitalPolicy {
  tier: CapitalTier;
  /** AI が tier 枠内で学習した cash buffer (%) */
  cashBufferPercent: number;
  /** AI が tier 枠内で学習した「強シグナル時の追加倍率」 */
  convictionBoost: number;
  /** 直近の昇進/降格イベント */
  lastTierChange: string;
  /** AI が policy を更新した日時 */
  lastAiUpdate: string;
  /** AI が policy を更新した根拠 (履歴) */
  reasoning: string;
  /** 集計時点のメトリクス snapshot (UI 表示用) */
  metrics: PolicyMetrics;
}

export interface PolicyMetrics {
  totalTrades: number;
  winRate: number;
  totalPnL: number;
  /** 簡易 Sharpe ratio (1 取引あたりの mean/std) */
  sharpe: number;
  /** 観測された最大ドローダウン (%) */
  maxDrawdownPercent: number;
  evaluatedAt: string;
}

const POLICY_FILE = "capital-policy";
const POLICY_LOG_FILE = "capital-policy-log";

const DEFAULT_POLICY: CapitalPolicy = {
  tier: "JUNIOR",
  cashBufferPercent: TIER_LIMITS.JUNIOR.cashBufferPercent,
  convictionBoost: 1.0,
  lastTierChange: new Date().toISOString(),
  lastAiUpdate: "1970-01-01T00:00:00Z",
  reasoning: "初期値 (JUNIOR: 投入 50% / バッファ 50%)",
  metrics: {
    totalTrades: 0,
    winRate: 0,
    totalPnL: 0,
    sharpe: 0,
    maxDrawdownPercent: 0,
    evaluatedAt: new Date().toISOString(),
  },
};

export async function getCapitalPolicy(): Promise<CapitalPolicy> {
  const p = await loadData<CapitalPolicy>(POLICY_FILE, DEFAULT_POLICY);
  // tier 整合 (壊れた JSON 防御)
  if (!TIER_LIMITS[p.tier]) p.tier = "JUNIOR";
  return p;
}

export async function getPolicyLog(limit = 20): Promise<CapitalPolicy[]> {
  const all = await loadData<CapitalPolicy[]>(POLICY_LOG_FILE, []);
  return all.slice(-limit);
}

/**
 * 直近の trades から評価メトリクスを計算.
 * Sharpe は (mean pnl) / (std pnl) で簡易化 (annualize しない、相対比較用).
 */
export function computePolicyMetrics(trades: TradeRecord[]): PolicyMetrics {
  const sells = trades.filter(t => t.side === "sell" && typeof t.pnl === "number");
  const pnls = sells.map(t => t.pnl ?? 0);
  const wins = pnls.filter(p => p > 0).length;
  const totalPnL = pnls.reduce((s, v) => s + v, 0);
  const winRate = pnls.length > 0 ? wins / pnls.length : 0;

  let sharpe = 0;
  if (pnls.length >= 5) {
    const mean = totalPnL / pnls.length;
    const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? mean / std : 0;
  }

  // Drawdown: 累計 PnL の cumulative max からの落ち込み (絶対値/cum max %)
  let cum = 0;
  let peak = 0;
  let maxDDAbs = 0;
  for (const v of pnls) {
    cum += v;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDDAbs) maxDDAbs = dd;
  }
  // % は peak が 0 だと意味薄い → peak<=0 なら 0
  const maxDrawdownPercent = peak > 0 ? (maxDDAbs / peak) * 100 : 0;

  return {
    totalTrades: pnls.length,
    winRate,
    totalPnL,
    sharpe,
    maxDrawdownPercent,
    evaluatedAt: new Date().toISOString(),
  };
}

interface TierCriteria {
  minTrades: number;
  minWinRate: number;
  minTotalPnL: number;
  minSharpe: number;
  maxDrawdownPercent: number;
}

const PROMOTION_CRITERIA: Record<CapitalTier, TierCriteria | null> = {
  JUNIOR: { minTrades: 30, minWinRate: 0.50, minTotalPnL: 1, minSharpe: 0, maxDrawdownPercent: 10 },
  MID: { minTrades: 100, minWinRate: 0.53, minTotalPnL: 1, minSharpe: 0.8, maxDrawdownPercent: 8 },
  SENIOR: { minTrades: 300, minWinRate: 0.55, minTotalPnL: 1, minSharpe: 1.2, maxDrawdownPercent: 6 },
  MASTER: null, // すでに最上位
};

const TIER_ORDER: CapitalTier[] = ["JUNIOR", "MID", "SENIOR", "MASTER"];

function nextTier(current: CapitalTier): CapitalTier | null {
  const idx = TIER_ORDER.indexOf(current);
  return idx < 0 || idx >= TIER_ORDER.length - 1 ? null : TIER_ORDER[idx + 1];
}

function prevTier(current: CapitalTier): CapitalTier | null {
  const idx = TIER_ORDER.indexOf(current);
  return idx <= 0 ? null : TIER_ORDER[idx - 1];
}

/**
 * 自動昇進/降格判定. trades から metrics を計算して policy を更新.
 * 呼び方: 1 日 1 回または retrospective 時に呼ぶ.
 *
 * 昇進: 現 tier の PROMOTION_CRITERIA を全部満たしたら 1 段上げる.
 * 降格: maxDD が tier 閾値の 2 倍超 or 累損益マイナスで取引数 ≥ 30 → 1 段下げる.
 *       JUNIOR からは降格しない.
 */
export async function evaluateTier(trades: TradeRecord[]): Promise<{
  policy: CapitalPolicy;
  changed: boolean;
  direction: "promotion" | "demotion" | "none";
  message: string;
}> {
  const current = await getCapitalPolicy();
  const metrics = computePolicyMetrics(trades);
  let newTier = current.tier;
  let direction: "promotion" | "demotion" | "none" = "none";
  let message = `現状維持 (${current.tier}, ${metrics.totalTrades}件 WR${(metrics.winRate * 100).toFixed(0)}%)`;

  // 昇進判定
  const crit = PROMOTION_CRITERIA[current.tier];
  if (crit) {
    const ok =
      metrics.totalTrades >= crit.minTrades &&
      metrics.winRate >= crit.minWinRate &&
      metrics.totalPnL >= crit.minTotalPnL &&
      metrics.sharpe >= crit.minSharpe &&
      metrics.maxDrawdownPercent <= crit.maxDrawdownPercent;
    if (ok) {
      const up = nextTier(current.tier);
      if (up) {
        newTier = up;
        direction = "promotion";
        message = `🎉 昇進: ${current.tier} → ${up} (${metrics.totalTrades}件 WR${(metrics.winRate * 100).toFixed(0)}% Sharpe${metrics.sharpe.toFixed(2)} DD${metrics.maxDrawdownPercent.toFixed(1)}%)`;
      }
    }
  }

  // 降格判定 (昇進してないときのみ)
  if (direction === "none" && current.tier !== "JUNIOR") {
    const myLimit = TIER_LIMITS[current.tier];
    const baselineDD = PROMOTION_CRITERIA[prevTier(current.tier) ?? "JUNIOR"]?.maxDrawdownPercent ?? 10;
    const severelyDD = metrics.maxDrawdownPercent > baselineDD * 2;
    const badWR = metrics.totalTrades >= 30 && metrics.winRate < 0.40;
    const bigLoss = metrics.totalTrades >= 30 && metrics.totalPnL < -myLimit.maxDeployPercent * 100; // 適当な大損閾値
    if (severelyDD || badWR || bigLoss) {
      const down = prevTier(current.tier);
      if (down) {
        newTier = down;
        direction = "demotion";
        const why = severelyDD ? `DD${metrics.maxDrawdownPercent.toFixed(1)}%` : badWR ? `WR${(metrics.winRate * 100).toFixed(0)}%` : `累損 ¥${metrics.totalPnL.toFixed(0)}`;
        message = `⚠️ 降格: ${current.tier} → ${down} (${why})`;
      }
    }
  }

  const changed = newTier !== current.tier;
  const newLimits = TIER_LIMITS[newTier];
  const policy: CapitalPolicy = {
    ...current,
    tier: newTier,
    // tier 変わったら buffer をデフォルトに戻す (AI が次に学習し直す)
    cashBufferPercent: changed ? newLimits.cashBufferPercent : Math.min(newLimits.bufferMaxPercent, Math.max(newLimits.bufferMinPercent, current.cashBufferPercent)),
    convictionBoost: changed ? 1.0 : Math.min(newLimits.maxConvictionBoost, Math.max(0.7, current.convictionBoost)),
    lastTierChange: changed ? new Date().toISOString() : current.lastTierChange,
    reasoning: changed ? message : current.reasoning,
    metrics,
  };

  if (changed) {
    await saveData(POLICY_FILE, policy);
    const logs = await loadData<CapitalPolicy[]>(POLICY_LOG_FILE, []);
    logs.push(policy);
    await saveData(POLICY_LOG_FILE, logs.slice(-50));
    console.log(`[capital-policy] ${message}`);
  } else {
    // metrics だけ更新 (tier 変えない、ログ追加もしない)
    await saveData(POLICY_FILE, policy);
  }

  return { policy, changed, direction, message };
}

/**
 * AI 提案を tier 枠内で適用. retrospective から呼ぶ.
 * 提案が枠外なら自動 clamp.
 */
export async function applyAiPolicyUpdate(input: {
  cashBufferPercent?: number;
  convictionBoost?: number;
  reasoning: string;
}): Promise<CapitalPolicy> {
  const current = await getCapitalPolicy();
  const limits = TIER_LIMITS[current.tier];

  const buffer = typeof input.cashBufferPercent === "number"
    ? Math.min(limits.bufferMaxPercent, Math.max(limits.bufferMinPercent, input.cashBufferPercent))
    : current.cashBufferPercent;

  const boost = typeof input.convictionBoost === "number"
    ? Math.min(limits.maxConvictionBoost, Math.max(0.7, input.convictionBoost))
    : current.convictionBoost;

  const policy: CapitalPolicy = {
    ...current,
    cashBufferPercent: buffer,
    convictionBoost: boost,
    lastAiUpdate: new Date().toISOString(),
    reasoning: String(input.reasoning).slice(0, 500),
  };

  await saveData(POLICY_FILE, policy);
  const logs = await loadData<CapitalPolicy[]>(POLICY_LOG_FILE, []);
  logs.push(policy);
  await saveData(POLICY_LOG_FILE, logs.slice(-50));
  console.log(`[capital-policy] AI 更新: ${current.tier} buffer ${current.cashBufferPercent}%→${buffer}% boost ${current.convictionBoost.toFixed(2)}→${boost.toFixed(2)}`);
  return policy;
}

/** 現 tier の limits を取得 */
export function limitsFor(tier: CapitalTier): TierLimits {
  return TIER_LIMITS[tier];
}
