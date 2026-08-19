/**
 * 上位トレンド判定。バックテストと本番エンジンで**同じ定義**を使うための単一の出所。
 *
 * 【なぜ必要か】2026-08-17 の実測。
 * 現行戦略 (クオンツ + 規律フィルタ + F&G 逆張り) を 3ペア × 3期間 = 9条件で
 * バックテストしたところ、**9条件すべてでマイナス** (平均 -17.5%)。
 * BTC/JPY 直近1年は 7戦0勝7敗で、エントリー理由は毎回
 * 「F&G 恐怖域 → 逆張り買い」だった。下降トレンドで落ちるナイフを掴み続けていた。
 *
 * 同じ条件で「移動平均 50/200 だけを見て、上昇トレンドの時だけロング」する
 * 対照群は平均 +24.1%。つまり負けの主因は執行でもチューニングでもなく、
 * **上位トレンドに逆らって買っていたこと**だった。
 *
 * ここではその 1 点だけを判定する。売買サイズや TP/SL には関与しない。
 */
import type { OHLCVBar } from "../types";
import { sma } from "../indicators";

export const TREND_FAST_PERIOD = 50;
export const TREND_SLOW_PERIOD = 200;

export interface TrendState {
  close: number;
  fast: number | null;
  slow: number | null;
  /** ロングを許す条件: 終値 > MA50 > MA200 */
  upTrend: boolean;
  /** ロングを畳む条件: 終値 < MA50 */
  belowFast: boolean;
  /**
   * ショートを許す条件: 終値 < MA200 かつ MA50 < MA200。
   * 「MA50 割れ」だけでショートすると強気相場の押し目を売り続けて破滅する
   * (5y バックテストで XRP -84%、ETH -48% を実測)。確定した下降トレンドに限る。
   */
  confirmedDownTrend: boolean;
  /** MA200 が計算できずに MA50 だけで判定した場合 true */
  degraded: boolean;
  label: string;
}

/**
 * バーの並びは「古い → 新しい」を前提とする (既存の getOHLCV と同じ向き)。
 * 判定できるだけのバーが無ければ null。呼び出し側でフォールバックを決める。
 */
export function evaluateTrend(
  bars: OHLCVBar[] | undefined | null,
  fastPeriod = TREND_FAST_PERIOD,
  slowPeriod = TREND_SLOW_PERIOD
): TrendState | null {
  if (!bars || bars.length < fastPeriod + 1) return null;

  const closes = bars.map((b) => b.close);
  const close = closes[closes.length - 1];
  const fastSeries = sma(closes, fastPeriod);
  const fast = fastSeries[fastSeries.length - 1];
  if (fast === null || fast === undefined) return null;

  const slowSeries = bars.length >= slowPeriod + 1 ? sma(closes, slowPeriod) : null;
  const slow = slowSeries ? slowSeries[slowSeries.length - 1] ?? null : null;
  const degraded = slow === null;

  const upTrend = degraded ? close > fast : close > fast && fast > (slow as number);
  const belowFast = close < fast;
  const confirmedDownTrend = degraded ? false : close < (slow as number) && fast < (slow as number);

  const label = degraded
    ? `終値 ${close.toFixed(0)} / MA${fastPeriod} ${fast.toFixed(0)} (MA${slowPeriod} 不足につき簡易判定)`
    : `終値 ${close.toFixed(0)} / MA${fastPeriod} ${fast.toFixed(0)} / MA${slowPeriod} ${(slow as number).toFixed(0)}`;

  return { close, fast, slow, upTrend, belowFast, confirmedDownTrend, degraded, label };
}

export interface TrendDecision {
  action: "BUY" | "SELL" | "HOLD";
  reason: string;
}

/**
 * MA ルールのエントリー判断。engine の巨大な関数から切り出して単体で検証できるようにしてある。
 *
 * バックテストの対照群 C (+ SL8) と同じ挙動:
 *   - 保有なし × 上昇トレンド        → 買う
 *   - 保有あり × 日足が MA50 割れ    → 撤退
 *   - それ以外                        → 何もしない (保有はそのまま)
 * トレンドが判定できないときは待機する。分からないときに賭けない。
 */
export function decideByTrend(trend: TrendState | null, holdsPosition: boolean): TrendDecision {
  if (!trend) {
    return { action: "HOLD", reason: "[MAルール] 日足トレンド判定不能のため待機" };
  }
  if (!holdsPosition && trend.upTrend) {
    return { action: "BUY", reason: `[MAルール] 日足 上昇トレンド (${trend.label})` };
  }
  if (holdsPosition && trend.belowFast) {
    return {
      action: "SELL",
      reason: `[MAルール撤退] 日足が MA${TREND_FAST_PERIOD} を割った (${trend.label})`,
    };
  }
  return {
    action: "HOLD",
    reason: holdsPosition
      ? `[MAルール] 保有継続 (${trend.label})`
      : `[MAルール] 上昇トレンドでないため待機 (${trend.label})`,
  };
}
