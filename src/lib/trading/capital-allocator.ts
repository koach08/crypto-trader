/**
 * 動的資金配分: 各ペアの直近成績から「どれだけ資金を割くか」を自動決定。
 *
 * 哲学:
 * - 勝ってるペアに資金集中、負けてるペアは絞る
 * - ただし統計不足 (取引 5件未満) なら均等配分から触らない
 * - 現金バッファを常時確保 (相場変動時の余力)
 * - 1 ペアの上限 (集中リスク回避)
 */

import type { TradeRecord } from "../types";

export interface PairAllocation {
  pair: string;
  maxJPY: number;
  multiplier: number;
  reason: string;
}

interface PairStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  recentPnL: number;
  avgPnLPerTrade: number;
}

const CASH_BUFFER_PERCENT = 30;     // 総資金の 30% は現金として確保
const PER_PAIR_MAX_PERCENT = 50;    // 1 ペアが投資可能総額の 50% を超えない
const RECENT_TRADE_LOOKBACK = 30;   // 直近 30 取引で評価

/** 直近の trade 履歴から各ペアの成績を集計 */
export function computePairStats(trades: TradeRecord[]): Map<string, PairStats> {
  const stats = new Map<string, PairStats>();
  // 直近 N 件の sell (確定損益あり) のみ対象
  const recent = trades
    .filter(t => t.side === "sell" && t.pnl !== undefined)
    .slice(-RECENT_TRADE_LOOKBACK * 5); // ペア数考慮で多めに見る

  for (const t of recent) {
    if (!stats.has(t.pair)) {
      stats.set(t.pair, { trades: 0, wins: 0, losses: 0, winRate: 0, recentPnL: 0, avgPnLPerTrade: 0 });
    }
    const s = stats.get(t.pair)!;
    s.trades++;
    s.recentPnL += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) s.wins++;
    else if ((t.pnl ?? 0) < 0) s.losses++;
  }

  // 各ペアの集計を仕上げ
  for (const s of stats.values()) {
    s.winRate = s.trades > 0 ? s.wins / s.trades : 0;
    s.avgPnLPerTrade = s.trades > 0 ? s.recentPnL / s.trades : 0;
  }

  return stats;
}

/**
 * Forward-looking signal: そのペアに「今チャンスあるか」を評価。
 * - quantComposite: 現在の quant スコア (-100 〜 +100)
 * - regime: 上昇トレンドなら +、下降なら -
 * - 強い BUY シグナルあるペアにはより多く配分
 */
export interface ForwardSignal {
  pair: string;
  /** -100 〜 +100、正は買いチャンス、負は売り圧力 */
  edgeScore: number;
  reason: string;
}

/**
 * 各ペアの maxJPY を動的に決定。
 *
 * @param totalCapitalJPY 全体の運用可能資金 (cash + 既存ポジション評価額)
 * @param pairs 取引対象ペア
 * @param trades 直近の取引履歴 (過去成績)
 * @param forwardSignals 各ペアの「今チャンス度」(forward-looking)
 */
export function computeAllocations(
  totalCapitalJPY: number,
  pairs: string[],
  trades: TradeRecord[],
  forwardSignals: ForwardSignal[] = []
): PairAllocation[] {
  const stats = computePairStats(trades);
  const investableTotal = totalCapitalJPY * (1 - CASH_BUFFER_PERCENT / 100);
  const baseEqual = pairs.length > 0 ? investableTotal / pairs.length : 0;
  const perPairCap = investableTotal * (PER_PAIR_MAX_PERCENT / 100);
  const forwardMap = new Map(forwardSignals.map(f => [f.pair, f]));

  const allocations: PairAllocation[] = [];

  for (const pair of pairs) {
    const s = stats.get(pair);
    const forward = forwardMap.get(pair);

    // === 過去成績の multiplier (0.3x 〜 1.5x) ===
    let pastMult = 1.0;
    let pastReason = "統計不足";
    if (s && s.trades >= 5) {
      if (s.winRate >= 0.6 && s.recentPnL > 0) {
        pastMult = 1.5;
        pastReason = `好成績 WR${(s.winRate * 100).toFixed(0)}% +¥${Math.round(s.recentPnL)}`;
      } else if (s.winRate >= 0.5 && s.recentPnL > 0) {
        pastMult = 1.2;
        pastReason = `プラス WR${(s.winRate * 100).toFixed(0)}%`;
      } else if (s.winRate >= 0.4 && s.recentPnL >= 0) {
        pastMult = 1.0;
        pastReason = `中立 WR${(s.winRate * 100).toFixed(0)}%`;
      } else if (s.winRate < 0.3 || s.recentPnL < -1000) {
        pastMult = 0.3;
        pastReason = `不調 WR${(s.winRate * 100).toFixed(0)}% ¥${Math.round(s.recentPnL)}`;
      } else {
        pastMult = 0.6;
        pastReason = `やや不調 WR${(s.winRate * 100).toFixed(0)}%`;
      }
    } else if (s) {
      pastReason = `データ少(${s.trades}件)`;
    }

    // === Forward-looking multiplier (0.5x 〜 1.5x) ===
    // edgeScore +30 以上 = 強い買いチャンス、配分増
    // edgeScore -30 以下 = 売り圧力、配分減
    let forwardMult = 1.0;
    let forwardReason = "中立";
    if (forward) {
      const e = forward.edgeScore;
      if (e >= 30) { forwardMult = 1.5; forwardReason = `強チャンス edge+${e}`; }
      else if (e >= 15) { forwardMult = 1.2; forwardReason = `チャンス edge+${e}`; }
      else if (e >= -15) { forwardMult = 1.0; forwardReason = `中立 edge${e}`; }
      else if (e >= -30) { forwardMult = 0.7; forwardReason = `弱気 edge${e}`; }
      else { forwardMult = 0.5; forwardReason = `売り圧 edge${e}`; }
    }

    // 過去 × Forward (両方見る、片方ダメなら配分減る)
    const multiplier = pastMult * forwardMult;
    const reason = `[過去] ${pastReason} × [Forward] ${forwardReason} = ${multiplier.toFixed(2)}x`;

    let maxJPY = baseEqual * multiplier;
    if (maxJPY > perPairCap) {
      maxJPY = perPairCap;
    }

    allocations.push({
      pair,
      maxJPY: Math.round(maxJPY),
      multiplier,
      reason,
    });
  }

  // 合計が investableTotal を超えてたら比例縮小
  const sumMax = allocations.reduce((s, a) => s + a.maxJPY, 0);
  if (sumMax > investableTotal) {
    const scale = investableTotal / sumMax;
    for (const a of allocations) {
      a.maxJPY = Math.round(a.maxJPY * scale);
    }
  }

  return allocations;
}

/** Map 形式で取り出し (engine で使いやすい) */
export function allocationsToMap(allocations: PairAllocation[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of allocations) m.set(a.pair, a.maxJPY);
  return m;
}
