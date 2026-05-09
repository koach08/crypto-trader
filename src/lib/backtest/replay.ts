/**
 * 過去replayバックテストエンジン
 *
 * 過去のOHLCV を順次再生し、各バーで現在の戦略 (signals + scoring + discipline)
 * を実行、シミュレートされた約定を行う。スリッページ・手数料込みで現実的に評価。
 *
 * 制約:
 *  - 単一銘柄、単一ポジション (片建て)
 *  - 約定: 翌バーの open 価格 + slippage
 *  - F&G 履歴は date → value で渡す (なければ neutral 50)
 */

import type { OHLCVBar } from "../types";
import { runQuantAnalysis } from "../quant/signals";
import { calculateFinalDecision } from "../quant/scoring-engine";
import { detectRegime, generateCryptoSignal } from "../indicators";
import { checkMTFAlignment, checkEdge, checkSentimentEdge } from "../trading/discipline";

export interface BacktestConfig {
  pair: string;
  bars: OHLCVBar[];
  fngByDate?: Map<string, number>;
  initialCapital: number;
  slippagePercent: number;
  feePercent: number;
  warmupBars?: number;
  emergencyLossPercent?: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
}

export interface SimTrade {
  side: "buy" | "sell";
  date: string;
  price: number;
  amount: number;
  fee: number;
  pnl?: number;
  pnlPercent?: number;
  reason: string;
  exitType?: "ai_sell" | "stop_loss" | "take_profit" | "emergency";
}

export interface EquityPoint {
  date: string;
  equity: number;
  cash: number;
  positionValue: number;
}

export interface BacktestStats {
  totalReturnPercent: number;
  buyAndHoldReturnPercent: number;
  alphaPercent: number;
  sharpe: number;
  maxDrawdownPercent: number;
  winRate: number;
  profitFactor: number;
  numTrades: number;
  numWins: number;
  numLosses: number;
  avgWinPercent: number;
  avgLossPercent: number;
  avgHoldDays: number;
  finalEquity: number;
  initialEquity: number;
}

export interface BacktestResult {
  pair: string;
  trades: SimTrade[];
  equityCurve: EquityPoint[];
  stats: BacktestStats;
  startDate: string;
  endDate: string;
  durationDays: number;
}

function dateOf(bar: OHLCVBar): string {
  return new Date(bar.timestamp).toISOString().split("T")[0];
}

export function runBacktest(config: BacktestConfig): BacktestResult {
  const {
    pair,
    bars,
    fngByDate,
    initialCapital,
    slippagePercent,
    feePercent,
    warmupBars = 50,
    emergencyLossPercent = 5.0,
    takeProfitPercent = 10.0,
    stopLossPercent = 2.0,
  } = config;

  if (bars.length < warmupBars + 5) {
    throw new Error(`バー数不足: ${bars.length} (要 >${warmupBars + 5})`);
  }

  let cash = initialCapital;
  let position: { amount: number; avgPrice: number; entryBarIdx: number } | null = null;
  const trades: SimTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  for (let i = warmupBars; i < bars.length - 1; i++) {
    const window = bars.slice(0, i + 1);
    const currentBar = bars[i];
    const nextBar = bars[i + 1];
    const date = dateOf(currentBar);
    const fng = fngByDate?.get(date) ?? 50;

    // 1) クオンツ + テクニカル + レジーム
    const quantAnalysis = runQuantAnalysis(window);
    const technical = generateCryptoSignal(window);
    const regime = detectRegime(window);

    // 2) スコアリングエンジン (AI は backtest では HOLD固定)
    const scoring = calculateFinalDecision({
      pair,
      price: currentBar.close,
      quantAnalysis,
      aiAction: "HOLD",
      aiConfidence: 50,
      aiReason: "backtest (no AI)",
      technicalScore: technical.score,
      regime,
      fearGreedIndex: fng,
    });

    let action = scoring.action;
    let reason = scoring.reason;

    // 3) 規律フィルタ
    // F&G は Quant 強い (|score|≥25) ならスキップ (トレンドフォローモード)
    if (action !== "HOLD") {
      const quantStrong = Math.abs(quantAnalysis.compositeScore) >= 25;
      if (!quantStrong) {
        const sent = checkSentimentEdge(fng, action);
        if (!sent.passed) action = "HOLD";
        reason += ` | ${sent.reason}`;
      } else {
        reason += " | F&G スキップ (Quant強い)";
      }
    }
    if (action !== "HOLD") {
      const mtf = checkMTFAlignment(window, action);
      if (!mtf.aligned) action = "HOLD";
      reason += ` | ${mtf.reason}`;
    }
    if (action !== "HOLD") {
      const edge = checkEdge(scoring.confidence, takeProfitPercent, stopLossPercent);
      if (!edge.passed) action = "HOLD";
    }

    // 4) ポジション管理 (SL/TP/緊急ロスカット)
    if (position) {
      const currentChange = ((currentBar.close - position.avgPrice) / position.avgPrice) * 100;

      // 緊急ロスカット
      if (currentChange <= -emergencyLossPercent) {
        const fillPrice = nextBar.open * (1 - slippagePercent / 100);
        const proceeds = position.amount * fillPrice;
        const fee = proceeds * (feePercent / 100);
        const pnl = proceeds - position.avgPrice * position.amount - fee;
        cash += proceeds - fee;
        trades.push({
          side: "sell",
          date: dateOf(nextBar),
          price: fillPrice,
          amount: position.amount,
          fee,
          pnl,
          pnlPercent: (pnl / (position.avgPrice * position.amount)) * 100,
          reason: `緊急ロスカット ${currentChange.toFixed(2)}%`,
          exitType: "emergency",
        });
        position = null;
      }
      // テイクプロフィット
      else if (currentChange >= takeProfitPercent) {
        const fillPrice = nextBar.open * (1 - slippagePercent / 100);
        const proceeds = position.amount * fillPrice;
        const fee = proceeds * (feePercent / 100);
        const pnl = proceeds - position.avgPrice * position.amount - fee;
        cash += proceeds - fee;
        trades.push({
          side: "sell",
          date: dateOf(nextBar),
          price: fillPrice,
          amount: position.amount,
          fee,
          pnl,
          pnlPercent: (pnl / (position.avgPrice * position.amount)) * 100,
          reason: `TP +${currentChange.toFixed(2)}%`,
          exitType: "take_profit",
        });
        position = null;
      }
      // SL ガード (config 指定)
      else if (currentChange <= -stopLossPercent) {
        const fillPrice = nextBar.open * (1 - slippagePercent / 100);
        const proceeds = position.amount * fillPrice;
        const fee = proceeds * (feePercent / 100);
        const pnl = proceeds - position.avgPrice * position.amount - fee;
        cash += proceeds - fee;
        trades.push({
          side: "sell",
          date: dateOf(nextBar),
          price: fillPrice,
          amount: position.amount,
          fee,
          pnl,
          pnlPercent: (pnl / (position.avgPrice * position.amount)) * 100,
          reason: `SL ${currentChange.toFixed(2)}%`,
          exitType: "stop_loss",
        });
        position = null;
      }
    }

    // 5) AI/quant 判断によるエントリー/イグジット
    if (action === "BUY" && !position && cash > 1000) {
      const fillPrice = nextBar.open * (1 + slippagePercent / 100);
      const fee = cash * (feePercent / 100);
      const amount = (cash - fee) / fillPrice;
      trades.push({
        side: "buy",
        date: dateOf(nextBar),
        price: fillPrice,
        amount,
        fee,
        reason,
      });
      position = { amount, avgPrice: fillPrice, entryBarIdx: i };
      cash = 0;
    } else if (action === "SELL" && position) {
      const fillPrice = nextBar.open * (1 - slippagePercent / 100);
      const proceeds = position.amount * fillPrice;
      const fee = proceeds * (feePercent / 100);
      const pnl = proceeds - position.avgPrice * position.amount - fee;
      cash += proceeds - fee;
      trades.push({
        side: "sell",
        date: dateOf(nextBar),
        price: fillPrice,
        amount: position.amount,
        fee,
        pnl,
        pnlPercent: (pnl / (position.avgPrice * position.amount)) * 100,
        reason,
        exitType: "ai_sell",
      });
      position = null;
    }

    // 6) Equity
    const positionValue = position ? position.amount * currentBar.close : 0;
    equityCurve.push({
      date,
      equity: cash + positionValue,
      cash,
      positionValue,
    });
  }

  // 最終バーで強制クローズ
  if (position) {
    const lastBar = bars[bars.length - 1];
    const fillPrice = lastBar.close * (1 - slippagePercent / 100);
    const proceeds = position.amount * fillPrice;
    const fee = proceeds * (feePercent / 100);
    const pnl = proceeds - position.avgPrice * position.amount - fee;
    cash += proceeds - fee;
    trades.push({
      side: "sell",
      date: dateOf(lastBar),
      price: fillPrice,
      amount: position.amount,
      fee,
      pnl,
      pnlPercent: (pnl / (position.avgPrice * position.amount)) * 100,
      reason: "バックテスト終了強制クローズ",
      exitType: "ai_sell",
    });
  }

  // === 統計算出 ===
  const finalEquity = cash;
  const initialEquity = initialCapital;
  const totalReturnPercent = ((finalEquity - initialEquity) / initialEquity) * 100;

  const firstClose = bars[warmupBars].close;
  const lastClose = bars[bars.length - 1].close;
  const buyAndHoldReturnPercent = ((lastClose - firstClose) / firstClose) * 100;
  const alphaPercent = totalReturnPercent - buyAndHoldReturnPercent;

  // 日次リターン
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) {
      dailyReturns.push((equityCurve[i].equity - prev) / prev);
    }
  }
  const meanDaily = dailyReturns.length
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length
    ? dailyReturns.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / dailyReturns.length
    : 0;
  const stdDaily = Math.sqrt(variance);
  // 暗号通貨は 365日取引、年率 Sharpe
  const sharpe = stdDaily > 0 ? (meanDaily / stdDaily) * Math.sqrt(365) : 0;

  // 最大ドローダウン
  let peak = equityCurve[0]?.equity ?? initialEquity;
  let maxDrawdownPercent = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  // 勝率と Profit Factor
  const sells = trades.filter((t) => t.side === "sell" && t.pnl !== undefined);
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0);
  const losses = sells.filter((t) => (t.pnl ?? 0) < 0);
  const numTrades = sells.length;
  const winRate = numTrades > 0 ? (wins.length / numTrades) * 100 : 0;
  const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const avgWinPercent = wins.length
    ? wins.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / wins.length
    : 0;
  const avgLossPercent = losses.length
    ? losses.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / losses.length
    : 0;
  // 平均保有日数
  const buys = trades.filter((t) => t.side === "buy");
  let totalHoldDays = 0;
  let pairs = 0;
  for (let bi = 0, si = 0; bi < buys.length; bi++) {
    if (si >= sells.length) break;
    const buyDate = new Date(buys[bi].date).getTime();
    const sellDate = new Date(sells[si].date).getTime();
    if (sellDate >= buyDate) {
      totalHoldDays += (sellDate - buyDate) / (1000 * 60 * 60 * 24);
      pairs++;
      si++;
    }
  }
  const avgHoldDays = pairs > 0 ? totalHoldDays / pairs : 0;

  return {
    pair,
    trades,
    equityCurve,
    stats: {
      totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
      buyAndHoldReturnPercent: Number(buyAndHoldReturnPercent.toFixed(2)),
      alphaPercent: Number(alphaPercent.toFixed(2)),
      sharpe: Number(sharpe.toFixed(2)),
      maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
      winRate: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      numTrades,
      numWins: wins.length,
      numLosses: losses.length,
      avgWinPercent: Number(avgWinPercent.toFixed(2)),
      avgLossPercent: Number(avgLossPercent.toFixed(2)),
      avgHoldDays: Number(avgHoldDays.toFixed(1)),
      finalEquity: Math.round(finalEquity),
      initialEquity: Math.round(initialEquity),
    },
    startDate: dateOf(bars[warmupBars]),
    endDate: dateOf(bars[bars.length - 1]),
    durationDays: Math.round(
      (bars[bars.length - 1].timestamp - bars[warmupBars].timestamp) / (1000 * 60 * 60 * 24)
    ),
  };
}
