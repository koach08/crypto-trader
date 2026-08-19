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

import type { CryptoAction, OHLCVBar } from "../types";
import { runQuantAnalysis } from "../quant/signals";
import { calculateFinalDecision } from "../quant/scoring-engine";
import { detectRegime, generateCryptoSignal } from "../indicators";
import { checkMTFAlignment, checkEdge, checkSentimentEdge } from "../trading/discipline";
import { evaluateTrend } from "../trading/trend-gate";

/**
 * `quant` = 既存のクオンツ + スコアリング + 規律フィルタ一式。
 * `trend`  = 移動平均だけの素朴なトレンドフォロー。既存スタックが本当に価値を
 *            出しているかを測るための対照群 (control)。これに勝てない実装は
 *            「複雑にした分だけ損している」ことになる。
 */
export type BacktestStrategy = "quant" | "trend";

export interface BacktestConfig {
  pair: string;
  bars: OHLCVBar[];
  fngByDate?: Map<string, number>;
  initialCapital: number;
  slippagePercent: number;
  feePercent: number;
  warmupBars?: number;
  strategy?: BacktestStrategy;
  /**
   * 上位トレンドに逆らう BUY を禁止する。
   * 実データで「F&G 恐怖 → 逆張り買い」が下落局面で 7戦0勝だったため、
   * 「落ちるナイフを掴まない」ことだけを条件に足す。
   */
  trendGate?: boolean;
  trendFast?: number;
  trendSlow?: number;
  /**
   * 一度買ったら売らない (下落しても保有継続)。
   * 「上昇トレンドでない間は現金で待つ」のと「暗号資産のまま持ち続ける」のを
   * 比較するために使う。
   */
  holdForever?: boolean;
  /**
   * SELL シグナルでショートを建てる (BitFlyer Lightning FX 相当、レバレッジ 1x で保守的に評価)。
   * 現物ロングだけでは下落局面で構造的に勝てないため、その分をここで測る。
   */
  allowShort?: boolean;
  /**
   * 上昇トレンドが確定しているときは F&G の「恐怖でなければ買うな」条件を外す。
   * この条件があると上げ相場 (F&G 50-75) では BUY が 1 本も出ず、
   * 結果として「恐怖で落ちている時にしか買わない」= 逆張り専用機になる。
   */
  trendFollowEntries?: boolean;
  emergencyLossPercent?: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  // フィルタ調整 (override 用)
  fngBuyThreshold?: number;       // 例: 35 (≤これで BUY 通す)、999 で実質無効
  fngSellThreshold?: number;      // 例: 65 (≥これで SELL 通す)、0 で実質無効
  quantOverrideThreshold?: number; // 例: 25 (|quant|≥これで F&G スキップ)
  skipMTF?: boolean;
  skipEV?: boolean;
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
    fngBuyThreshold = 35,
    fngSellThreshold = 65,
    quantOverrideThreshold = 25,
    skipMTF = false,
    skipEV = false,
    strategy = "quant",
    trendGate = false,
    trendFast = 50,
    trendSlow = 200,
    allowShort = false,
    trendFollowEntries = false,
    holdForever = false,
  } = config;

  if (bars.length < warmupBars + 5) {
    throw new Error(`バー数不足: ${bars.length} (要 >${warmupBars + 5})`);
  }

  let cash = initialCapital;
  type SimPosition = { side: "long" | "short"; amount: number; avgPrice: number; entryBarIdx: number };
  let position: SimPosition | null = null;
  const trades: SimTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  const slipUp = 1 + slippagePercent / 100;   // 買い側は不利に上へ滑る
  const slipDown = 1 - slippagePercent / 100; // 売り側は不利に下へ滑る

  /** エントリーからの損益率。ショートは価格が下がるほどプラス。 */
  function changePercentOf(p: SimPosition, price: number): number {
    const raw = ((price - p.avgPrice) / p.avgPrice) * 100;
    return p.side === "long" ? raw : -raw;
  }

  // ヘルパーは position を直接書き換えず、新しい値を返す。
  // (クロージャ内で let を代入すると TypeScript の絞り込みが効かなくなるため)
  function openPosition(
    side: "long" | "short",
    barOpen: number,
    date: string,
    reason: string,
    barIdx: number
  ): SimPosition {
    const fillPrice = side === "long" ? barOpen * slipUp : barOpen * slipDown;
    const notional = cash;
    const fee = notional * (feePercent / 100);
    const amount = (notional - fee) / fillPrice;
    trades.push({
      side: side === "long" ? "buy" : "sell",
      date,
      price: fillPrice,
      amount,
      fee,
      reason,
    });
    // ロングは現金を現物に変える。ショートは現金を証拠金として残し手数料だけ引く。
    cash = side === "long" ? 0 : cash - fee;
    return { side, amount, avgPrice: fillPrice, entryBarIdx: barIdx };
  }

  function closePosition(
    p: SimPosition,
    barOpen: number,
    date: string,
    reason: string,
    exitType: SimTrade["exitType"]
  ): null {
    const fillPrice = p.side === "long" ? barOpen * slipDown : barOpen * slipUp;
    const notional = p.amount * fillPrice;
    const fee = notional * (feePercent / 100);
    const gross =
      p.side === "long"
        ? (fillPrice - p.avgPrice) * p.amount
        : (p.avgPrice - fillPrice) * p.amount;
    const pnl = gross - fee;
    // ロングは売却代金がまるごと現金に戻る。ショートは証拠金が残っているので損益だけ足す。
    cash += p.side === "long" ? notional - fee : pnl;
    trades.push({
      side: p.side === "long" ? "sell" : "buy",
      date,
      price: fillPrice,
      amount: p.amount,
      fee,
      pnl,
      pnlPercent: (pnl / (p.avgPrice * p.amount)) * 100,
      reason,
      exitType,
    });
    return null;
  }

  for (let i = warmupBars; i < bars.length - 1; i++) {
    const window = bars.slice(0, i + 1);
    const currentBar = bars[i];
    const nextBar = bars[i + 1];
    const date = dateOf(currentBar);
    const fng = fngByDate?.get(date) ?? 50;

    // 0) 上位トレンド。本番エンジンと同じ定義を使う (trend-gate.ts が単一の出所)
    const trend = evaluateTrend(window, trendFast, trendSlow);
    const upTrend = trend?.upTrend ?? false;
    const belowFast = trend?.belowFast ?? false;
    const confirmedDownTrend = trend?.confirmedDownTrend ?? false;

    let action: CryptoAction;
    let reason: string;

    if (strategy === "trend") {
      // 対照群: 移動平均だけ。クオンツも AI も F&G も一切見ない。
      action = upTrend ? "BUY" : belowFast && !holdForever ? "SELL" : "HOLD";
      reason = `trend control: ${trend?.label ?? "トレンド判定不能"}`;
    } else {
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

      action = scoring.action;
      reason = scoring.reason;

      // 3) 規律フィルタ
      // F&G は Quant 強い (|score|≥25) ならスキップ (トレンドフォローモード)
      if (action !== "HOLD") {
        const quantStrong = Math.abs(quantAnalysis.compositeScore) >= 25;
        // 上昇トレンド確定中の BUY は F&G 条件を免除する (順張りモード)
        const trendFollowBuy = trendFollowEntries && action === "BUY" && upTrend;
        if (trendFollowBuy) {
          reason += " | F&G スキップ (上昇トレンド確定の順張り)";
        } else if (!quantStrong) {
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
      // 落ちるナイフを掴まない: 上位トレンドが下向きの間は新規 BUY を出さない
      if (trendGate && action === "BUY" && !upTrend) {
        action = "HOLD";
        reason += ` | trendGate: 上位トレンド下向き (MA${trendFast} 割れ/デッドクロス) のため BUY 見送り`;
      }
    }

    // 4) ポジション管理 (SL/TP/緊急ロスカット)
    if (position && !holdForever) {
      const currentChange = changePercentOf(position, currentBar.close);
      if (currentChange <= -emergencyLossPercent) {
        position = closePosition(position, nextBar.open, dateOf(nextBar), `緊急ロスカット ${currentChange.toFixed(2)}%`, "emergency");
      } else if (currentChange >= takeProfitPercent) {
        position = closePosition(position, nextBar.open, dateOf(nextBar), `TP +${currentChange.toFixed(2)}%`, "take_profit");
      } else if (currentChange <= -stopLossPercent) {
        position = closePosition(position, nextBar.open, dateOf(nextBar), `SL ${currentChange.toFixed(2)}%`, "stop_loss");
      }
    }

    // 5) 判断によるエントリー/イグジット
    // 反対シグナルが出たら、まず今のポジションを閉じてから逆側を建てる (同バー内でドテン)。
    if (position && ((action === "SELL" && position.side === "long") || (action === "BUY" && position.side === "short"))) {
      position = closePosition(position, nextBar.open, dateOf(nextBar), reason, "ai_sell");
    }
    if (!position && cash > 1000) {
      if (action === "BUY") {
        position = openPosition("long", nextBar.open, dateOf(nextBar), reason, i);
      } else if (action === "SELL" && allowShort && confirmedDownTrend) {
        position = openPosition("short", nextBar.open, dateOf(nextBar), `${reason} | 確定下降トレンドのみショート`, i);
      }
    }

    // 6) Equity
    const positionValue = position
      ? position.side === "long"
        ? position.amount * currentBar.close
        : // ショートは cash を証拠金として置いたままなので、含み損益だけ足す
          (position.avgPrice - currentBar.close) * position.amount
      : 0;
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
    position = closePosition(position, lastBar.close, dateOf(lastBar), "バックテスト終了強制クローズ", "ai_sell");
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
  // ショートの決済は side="buy" になるので、side ではなく exitType の有無で決済を判定する。
  const exits = trades.filter((t) => t.exitType !== undefined && t.pnl !== undefined);
  const wins = exits.filter((t) => (t.pnl ?? 0) > 0);
  const losses = exits.filter((t) => (t.pnl ?? 0) < 0);
  const numTrades = exits.length;
  const winRate = numTrades > 0 ? (wins.length / numTrades) * 100 : 0;
  const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const sells = exits; // 平均保有日数の算出で使う
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const avgWinPercent = wins.length
    ? wins.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / wins.length
    : 0;
  const avgLossPercent = losses.length
    ? losses.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / losses.length
    : 0;
  // 平均保有日数
  const buys = trades.filter((t) => t.exitType === undefined);
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
