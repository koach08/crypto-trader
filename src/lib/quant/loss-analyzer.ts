/**
 * 損失横断分析: 個別の reflection ではなく「全損失をまとめて」パターン抽出。
 *
 * 「どのレジームで負けやすい」「どの時間帯で」「どのシグナル組合せで」を統計的に出す。
 * Claude に丸投げするより数字でファクトを出す方が判断しやすい。
 */

import type { DecisionAudit } from "./audit-log";
import type { TradeRecord } from "../types";

export interface LossPattern {
  category: string;
  /** どんな傾向か */
  finding: string;
  /** その傾向に当てはまる損失件数 */
  matchCount: number;
  /** その損失合計額 */
  totalLoss: number;
  /** 全損失中の比率 (0-1) */
  share: number;
  /** 提案アクション (engine が活用できる形) */
  suggestion: string;
}

interface LossEvent {
  pair: string;
  pnl: number;
  pnlPercent: number;
  timestamp: string;
  audit?: DecisionAudit;
}

export function analyzeLossPatterns(
  trades: TradeRecord[],
  audits: DecisionAudit[]
): {
  totalLosses: number;
  totalLossJPY: number;
  patterns: LossPattern[];
  topPair: { pair: string; losses: number; totalLoss: number } | null;
  topRegime: { regime: string; losses: number; totalLoss: number } | null;
  topTimeRange: { range: string; losses: number; totalLoss: number } | null;
} {
  // 損失 trade のみ
  const losses: LossEvent[] = trades
    .filter(t => t.side === "sell" && (t.pnl ?? 0) < 0)
    .map(t => {
      // tradeに対応する audit を timestamp 近接で探す
      const tradeMs = new Date(t.timestamp).getTime();
      const audit = audits
        .filter(a => a.pair === t.pair)
        .sort((a, b) => Math.abs(new Date(a.timestamp).getTime() - tradeMs) - Math.abs(new Date(b.timestamp).getTime() - tradeMs))[0];
      return {
        pair: t.pair,
        pnl: t.pnl ?? 0,
        pnlPercent: t.pnlPercent ?? 0,
        timestamp: t.timestamp,
        audit,
      };
    });

  if (losses.length === 0) {
    return {
      totalLosses: 0,
      totalLossJPY: 0,
      patterns: [],
      topPair: null,
      topRegime: null,
      topTimeRange: null,
    };
  }

  const totalLossJPY = losses.reduce((s, l) => s + l.pnl, 0);
  const patterns: LossPattern[] = [];

  // ========== 1. ペア別 ==========
  const byPair: Record<string, { count: number; total: number }> = {};
  for (const l of losses) {
    if (!byPair[l.pair]) byPair[l.pair] = { count: 0, total: 0 };
    byPair[l.pair].count++;
    byPair[l.pair].total += l.pnl;
  }
  const sortedPairs = Object.entries(byPair).sort(([, a], [, b]) => a.total - b.total);
  const topPair = sortedPairs.length > 0
    ? { pair: sortedPairs[0][0], losses: sortedPairs[0][1].count, totalLoss: sortedPairs[0][1].total }
    : null;

  for (const [pair, data] of sortedPairs) {
    const share = Math.abs(data.total) / Math.abs(totalLossJPY);
    if (share >= 0.3) {
      patterns.push({
        category: "ペア集中",
        finding: `${pair} が損失の ${(share * 100).toFixed(0)}% を占める (${data.count} 件 / ¥${Math.round(data.total).toLocaleString()})`,
        matchCount: data.count,
        totalLoss: data.total,
        share,
        suggestion: `${pair} の取引を縮小、または一旦除外して他ペアで運用`,
      });
    }
  }

  // ========== 2. レジーム別 (audit があるもののみ) ==========
  const byRegime: Record<string, { count: number; total: number }> = {};
  for (const l of losses) {
    const regime = l.audit?.marketState?.regime;
    if (!regime) continue;
    if (!byRegime[regime]) byRegime[regime] = { count: 0, total: 0 };
    byRegime[regime].count++;
    byRegime[regime].total += l.pnl;
  }
  const sortedRegimes = Object.entries(byRegime).sort(([, a], [, b]) => a.total - b.total);
  const topRegime = sortedRegimes.length > 0
    ? { regime: sortedRegimes[0][0], losses: sortedRegimes[0][1].count, totalLoss: sortedRegimes[0][1].total }
    : null;
  for (const [regime, data] of sortedRegimes) {
    const share = Math.abs(data.total) / Math.abs(totalLossJPY);
    if (share >= 0.3) {
      patterns.push({
        category: "レジーム集中",
        finding: `${regime} 局面が損失の ${(share * 100).toFixed(0)}% を占める (${data.count} 件)`,
        matchCount: data.count,
        totalLoss: data.total,
        share,
        suggestion: regime === "TRENDING_DOWN"
          ? "下降トレンドで BUY しないよう regime score の重み増、または BUY 自動停止"
          : regime === "RANGING"
          ? "レンジ相場で TP/SL 範囲を狭める (scalp 化)"
          : `${regime} 局面の閾値を厳格化`,
      });
    }
  }

  // ========== 3. 時間帯別 ==========
  const byHour: Record<string, { count: number; total: number }> = {};
  for (const l of losses) {
    const date = new Date(l.timestamp);
    const jstHour = (date.getUTCHours() + 9) % 24;
    const range = `${String(Math.floor(jstHour / 4) * 4).padStart(2, "0")}-${String(Math.floor(jstHour / 4) * 4 + 4).padStart(2, "0")}`;
    if (!byHour[range]) byHour[range] = { count: 0, total: 0 };
    byHour[range].count++;
    byHour[range].total += l.pnl;
  }
  const sortedHours = Object.entries(byHour).sort(([, a], [, b]) => a.total - b.total);
  const topTimeRange = sortedHours.length > 0
    ? { range: sortedHours[0][0], losses: sortedHours[0][1].count, totalLoss: sortedHours[0][1].total }
    : null;
  for (const [range, data] of sortedHours) {
    const share = Math.abs(data.total) / Math.abs(totalLossJPY);
    if (share >= 0.4) {
      patterns.push({
        category: "時間帯集中",
        finding: `JST ${range}時 が損失の ${(share * 100).toFixed(0)}% を占める`,
        matchCount: data.count,
        totalLoss: data.total,
        share,
        suggestion: `JST ${range}時 の BUY を控える (流動性 or 特定セッション悪い)`,
      });
    }
  }

  // ========== 4. 確信度別 ==========
  const byConfidence: Record<string, { count: number; total: number }> = {};
  for (const l of losses) {
    if (!l.audit) continue;
    const c = l.audit.finalConfidence;
    const range = c >= 90 ? "90+" : c >= 80 ? "80-89" : c >= 70 ? "70-79" : c >= 60 ? "60-69" : "<60";
    if (!byConfidence[range]) byConfidence[range] = { count: 0, total: 0 };
    byConfidence[range].count++;
    byConfidence[range].total += l.pnl;
  }
  for (const [range, data] of Object.entries(byConfidence).sort(([, a], [, b]) => a.total - b.total)) {
    const share = Math.abs(data.total) / Math.abs(totalLossJPY);
    if (share >= 0.4) {
      patterns.push({
        category: "確信度",
        finding: `確信度 ${range}% の判断が損失の ${(share * 100).toFixed(0)}% を占める`,
        matchCount: data.count,
        totalLoss: data.total,
        share,
        suggestion: range === "90+" || range === "80-89"
          ? "高確信度でも負ける = 確信度キャリブレーションが甘い、シグナル側の精度向上必要"
          : `確信度 ${range}% は実質負けやすい → 閾値引き上げ検討`,
      });
    }
  }

  // ========== 5. 損失幅別 (大損 vs 小損) ==========
  const bigLosses = losses.filter(l => Math.abs(l.pnlPercent) >= 1.5);
  if (bigLosses.length > 0) {
    const bigTotal = bigLosses.reduce((s, l) => s + l.pnl, 0);
    const share = Math.abs(bigTotal) / Math.abs(totalLossJPY);
    if (share >= 0.5) {
      patterns.push({
        category: "大損集中",
        finding: `1.5%以上の大損が全損失の ${(share * 100).toFixed(0)}% を占める (${bigLosses.length} 件)`,
        matchCount: bigLosses.length,
        totalLoss: bigTotal,
        share,
        suggestion: "SL を厳格化 (例: 1.5% → 1.0%) で大損を抑制",
      });
    }
  }

  return {
    totalLosses: losses.length,
    totalLossJPY,
    patterns: patterns.sort((a, b) => b.share - a.share),
    topPair,
    topRegime,
    topTimeRange,
  };
}
