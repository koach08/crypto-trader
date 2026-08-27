/**
 * 運用成績の指標。
 *
 * 【なぜ要るか】「印象的な利益率を出した自動売買システムの 73% が 12 か月以内に
 * 失敗する。理由は、本当に重要な指標を一度も測っていなかったこと」という調査がある。
 * このアプリも損益は出していたが、**ドローダウン・プロフィットファクター・
 * 期待値・損益比のどれも計算していなかった**。損益だけ見ていると、
 * 「相場が上げたから含みが増えた」と「仕組みが機能した」の区別がつかない。
 *
 * 機関投資家が使う目安 (公開されている水準):
 *   Sharpe > 1.5 / 最大ドローダウン < 20% / プロフィットファクター > 1.8
 * これを合格ラインとして併記する。数字だけ出しても、良し悪しが分からない。
 */

export interface DrawdownPoint {
  at: string;
  equityJPY: number;
}

export interface DrawdownResult {
  /** ピークからの最大下落率 (負の数) */
  maxDrawdownPercent: number;
  maxDrawdownJPY: number;
  peakAt: string | null;
  troughAt: string | null;
  /** 現在のピークからの下落率 (負の数。ピーク更新中なら 0) */
  currentDrawdownPercent: number;
  /** 直近のピークからここまでの日数 (水面下にいる期間) */
  daysUnderwater: number;
}

export function computeDrawdown(series: DrawdownPoint[]): DrawdownResult {
  const empty: DrawdownResult = {
    maxDrawdownPercent: 0, maxDrawdownJPY: 0, peakAt: null, troughAt: null,
    currentDrawdownPercent: 0, daysUnderwater: 0,
  };
  if (series.length === 0) return empty;

  let peak = series[0].equityJPY;
  let peakAt = series[0].at;
  let maxDd = 0;
  let maxDdJPY = 0;
  let maxPeakAt: string | null = null;
  let maxTroughAt: string | null = null;
  let lastPeakAt = series[0].at;

  for (const p of series) {
    if (p.equityJPY > peak) {
      peak = p.equityJPY;
      peakAt = p.at;
      lastPeakAt = p.at;
    }
    // ピークが 0 以下だと率が出せない。金額だけ見る
    const ddJPY = p.equityJPY - peak;
    const ddPct = peak > 0 ? (ddJPY / peak) * 100 : 0;
    if (ddPct < maxDd) {
      maxDd = ddPct;
      maxDdJPY = ddJPY;
      maxPeakAt = peakAt;
      maxTroughAt = p.at;
    }
  }

  const last = series[series.length - 1];
  const currentDd = peak > 0 ? ((last.equityJPY - peak) / peak) * 100 : 0;
  const days = currentDd < 0
    ? Math.max(0, (Date.parse(last.at) - Date.parse(lastPeakAt)) / 86_400_000)
    : 0;

  return {
    maxDrawdownPercent: maxDd,
    maxDrawdownJPY: maxDdJPY,
    peakAt: maxPeakAt,
    troughAt: maxTroughAt,
    currentDrawdownPercent: currentDd,
    daysUnderwater: Math.round(days * 10) / 10,
  };
}

export interface TradeQuality {
  trades: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  /** 勝ちの合計 ÷ 負けの合計。1.0 で損益トントン */
  profitFactor: number;
  /** 平均利益 ÷ 平均損失 */
  payoffRatio: number;
  /** 1 回あたりの期待値 */
  expectancyJPY: number;
  /** この勝率で収支を合わせるのに必要な損益比 */
  requiredPayoffRatio: number;
  /** 必要な損益比に届いているか */
  hasEdge: boolean;
}

export function computeTradeQuality(input: {
  wins: number;
  losses: number;
  grossProfitJPY: number;
  grossLossJPY: number;
}): TradeQuality {
  const { wins, losses, grossProfitJPY, grossLossJPY } = input;
  const trades = wins + losses;
  const winRate = trades > 0 ? wins / trades : 0;
  const avgWin = wins > 0 ? grossProfitJPY / wins : 0;
  const avgLoss = losses > 0 ? grossLossJPY / losses : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;
  // 勝率 p で期待値 0 になる損益比は (1-p)/p
  const required = winRate > 0 ? (1 - winRate) / winRate : Infinity;
  return {
    trades,
    wins,
    losses,
    winRatePercent: winRate * 100,
    profitFactor: grossLossJPY > 0 ? grossProfitJPY / grossLossJPY : (grossProfitJPY > 0 ? Infinity : 0),
    payoffRatio: payoff,
    expectancyJPY: trades > 0 ? (grossProfitJPY - grossLossJPY) / trades : 0,
    requiredPayoffRatio: required,
    hasEdge: payoff >= required && trades > 0,
  };
}

/** 機関投資家の目安。数字だけ出しても良し悪しが分からないので併記する。 */
export const INSTITUTIONAL_BENCHMARK = {
  maxDrawdownPercent: -20,
  profitFactor: 1.8,
  sharpe: 1.5,
} as const;
