/**
 * Auto-guardrails: 損失データから自動的に block 条件を導出して保存。
 *
 * - 定期 (engine.ts から N サイクルごと) に analyzeLossPatterns を回す
 * - share >= 0.5 のパターンを「自動ガード」化
 *   - 損失集中ペア → そのペアの conf 閾値 +10
 *   - 損失集中 regime → その regime での BUY conf 閾値 +10
 *   - 損失集中時間帯 → その JST 時間帯の BUY 完全 block
 * - 結果を data/auto-guardrails.json に保存
 * - engine.ts の evaluateAdaptiveBuyGuardrails が読みに行く
 */

import { loadData, saveData } from "../data";
import { analyzeLossPatterns } from "./loss-analyzer";
import { getAudits } from "./audit-log";
import type { TradeRecord } from "../types";

export interface AutoGuardrails {
  computedAt: string;
  basedOnLosses: number;
  totalLossJPY: number;
  /** 損失集中で conf 閾値 +10 すべきペア */
  highRiskPairs: string[];
  /** 損失集中で BUY 閾値 +10 すべき regime */
  highRiskRegimes: string[];
  /** 損失集中で BUY 完全 block すべき JST 時間帯 (例: ["16-20"]) */
  blockedHourRanges: string[];
  /** 表示用 reasoning */
  reasons: string[];
}

const FILE = "auto-guardrails";
const PAIR_SHARE_THRESHOLD = 0.5;
const REGIME_SHARE_THRESHOLD = 0.5;
const HOUR_SHARE_THRESHOLD = 0.4;

export async function computeAutoGuardrails(trades: TradeRecord[]): Promise<AutoGuardrails> {
  const audits = await getAudits(500).catch(() => []);
  const analysis = analyzeLossPatterns(trades, audits);

  const highRiskPairs: string[] = [];
  const highRiskRegimes: string[] = [];
  const blockedHourRanges: string[] = [];
  const reasons: string[] = [];

  for (const p of analysis.patterns) {
    if (p.category === "ペア集中" && p.share >= PAIR_SHARE_THRESHOLD) {
      const pairMatch = p.finding.match(/^(\S+)/);
      if (pairMatch) {
        highRiskPairs.push(pairMatch[1]);
        reasons.push(`${pairMatch[1]} 損失集中 (${(p.share * 100).toFixed(0)}%) → conf閾値 +10`);
      }
    }
    if (p.category === "レジーム集中" && p.share >= REGIME_SHARE_THRESHOLD) {
      const regimeMatch = p.finding.match(/^(\S+)/);
      if (regimeMatch) {
        highRiskRegimes.push(regimeMatch[1]);
        reasons.push(`${regimeMatch[1]} 局面で損失集中 (${(p.share * 100).toFixed(0)}%) → BUY 閾値 +10`);
      }
    }
    if (p.category === "時間帯集中" && p.share >= HOUR_SHARE_THRESHOLD) {
      const hourMatch = p.finding.match(/JST (\d{2}-\d{2})時/);
      if (hourMatch) {
        blockedHourRanges.push(hourMatch[1]);
        reasons.push(`JST ${hourMatch[1]}時 損失集中 (${(p.share * 100).toFixed(0)}%) → 当該時間帯の BUY block`);
      }
    }
  }

  const guardrails: AutoGuardrails = {
    computedAt: new Date().toISOString(),
    basedOnLosses: analysis.totalLosses,
    totalLossJPY: analysis.totalLossJPY,
    highRiskPairs,
    highRiskRegimes,
    blockedHourRanges,
    reasons,
  };

  await saveData(FILE, guardrails);
  return guardrails;
}

export async function getAutoGuardrails(): Promise<AutoGuardrails | null> {
  return loadData<AutoGuardrails | null>(FILE, null);
}

/** JST 時間 (0-23) が block 対象に含まれるか */
export function isBlockedHourJST(blockedRanges: string[], hourJST?: number): boolean {
  const h = hourJST ?? ((new Date().getUTCHours() + 9) % 24);
  for (const range of blockedRanges) {
    const m = range.match(/^(\d{2})-(\d{2})$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (h >= start && h < end) return true;
  }
  return false;
}
