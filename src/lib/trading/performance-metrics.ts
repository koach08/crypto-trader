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

/**
 * 入出金を差し引いた資産曲線を作る。
 *
 * 【なぜ総資産そのままではだめか】入金すると総資産が跳ね上がり、下落率が薄まる。
 * 【なぜ暗号資産の評価額だけでもだめか】現金に寄せた時期が「ほぼ全損」に見える。
 * 実際、口座がほぼ全額 JPY だった記録が 79 点あり、それを評価額だけで測ったら
 * 最大ドローダウンが **-99.9%** と出た。現金にいるのは損ではない。
 *
 * 見たいのは「入れた金に対して、資産がピークからどれだけ落ちたか」なので、
 * 総資産からその時点までの入金累計を引く。
 */
export function buildEquityCurve(
  navHistory: Array<{ timestamp: string; total: number }>,
  flows: Array<{ at: string; amountJPY: number }>
): DrawdownPoint[] {
  const sortedFlows = [...flows].sort((a, b) => a.at.localeCompare(b.at));
  const sorted = [...navHistory].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const out: DrawdownPoint[] = [];
  let idx = 0;
  let cumulative = 0;
  for (const n of sorted) {
    while (idx < sortedFlows.length && sortedFlows[idx].at <= n.timestamp) {
      cumulative += sortedFlows[idx].amountJPY;
      idx++;
    }
    out.push({ at: n.timestamp, equityJPY: n.total - cumulative });
  }
  return out;
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

/**
 * 戦術枠にいくら張らせるかを、実績から決める。
 *
 * 【なぜ要るか】これまで戦術枠は「余った現金を全部使ってよい」構造だった。
 * 実測では 1 回あたりの期待値が -¥114 で、187 決済で -¥6,119 を作っている。
 * 期待値がマイナスの仕組みに満額を張らせる理由が無い。
 *
 * 【止めずに縮める理由】完全に止めると新しい成績が一件も溜まらず、
 * 「直したものが効いたか」を永久に判定できなくなる。実際、リスク判定が
 * コア枠を危険視して戦術枠を全停止させたとき、それが起きた。
 * だから止めるのではなく張る額を落とす。悪ければ小さく、良くなれば戻す。
 *
 * 【全期間ではなく直近で測る理由】設定を変えた後の成績が、変える前の
 * 大量のサンプルに埋もれてしまうため。
 */
export interface EdgeBudgetResult {
  /** 1 回のリスク割合 (総資産に対して) */
  riskFraction: number;
  /** 満額に対する倍率 */
  multiplier: number;
  /** 判定に使ったサンプル数 */
  samples: number;
  phase: "観察中" | "エッジ未確認" | "エッジ確認";
  reason: string;
}

export function evaluateEdgeBudget(input: {
  quality: TradeQuality;
  /** これ未満のサンプルでは良し悪しを判定しない */
  minSamples: number;
  /** エッジが確認できたときの 1 回のリスク割合 */
  baseRiskFraction: number;
}): EdgeBudgetResult {
  const { quality, minSamples, baseRiskFraction } = input;

  if (quality.trades < minSamples) {
    // 判定材料が足りない。半分の大きさで様子を見ながらサンプルを溜める。
    return {
      riskFraction: baseRiskFraction * 0.5,
      multiplier: 0.5,
      samples: quality.trades,
      phase: "観察中",
      reason: `直近 ${quality.trades} 件では判定できない (${minSamples} 件必要)。半分の大きさで様子を見る`,
    };
  }

  if (!quality.hasEdge || quality.expectancyJPY <= 0) {
    return {
      riskFraction: baseRiskFraction * 0.25,
      multiplier: 0.25,
      samples: quality.trades,
      phase: "エッジ未確認",
      reason:
        `直近 ${quality.trades} 件で期待値 ¥${Math.round(quality.expectancyJPY).toLocaleString()}/回、` +
        `損益比 ${quality.payoffRatio.toFixed(2)} (必要 ${quality.requiredPayoffRatio.toFixed(2)})。` +
        `張る額を 1/4 に落とす`,
    };
  }

  return {
    riskFraction: baseRiskFraction,
    multiplier: 1,
    samples: quality.trades,
    phase: "エッジ確認",
    reason:
      `直近 ${quality.trades} 件で期待値 ¥${Math.round(quality.expectancyJPY).toLocaleString()}/回、` +
      `損益比 ${quality.payoffRatio.toFixed(2)} が必要水準 ${quality.requiredPayoffRatio.toFixed(2)} を上回る`,
  };
}
