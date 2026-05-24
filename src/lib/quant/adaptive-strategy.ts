import type { DecisionAudit } from "./audit-log";
import { analyzeLossPatterns, type LossPattern } from "./loss-analyzer";
import { analyzeMultiTimeframe, type MultiTimeframeAnalysis } from "./timeframe-analyzer";
import type { DailyPnL, OHLCVBar, Position, TickerData, TradeRecord } from "../types";

export type StrategyHorizon = "short" | "medium" | "long";
export type StrategyAction = "HOLD" | "WAIT" | "REDUCE" | "EXIT" | "ADD_SMALL";

export interface HorizonPlan {
  horizon: StrategyHorizon;
  label: string;
  action: StrategyAction;
  confidence: number;
  thesis: string;
  invalidation: string;
}

export interface PositionStrategyPlan {
  pair: string;
  currentPrice: number;
  entryPrice: number;
  valueJPY: number;
  unrealizedPnLJPY: number;
  unrealizedPnLPercent: number;
  mtf: MultiTimeframeAnalysis | null;
  posture: "PROTECT" | "REPAIR" | "COMPOUND";
  plans: HorizonPlan[];
  rules: string[];
}

export interface AdaptiveStrategyReport {
  generatedAt: string;
  portfolioPosture: "DEFENSIVE" | "RECOVERY" | "GROWTH";
  dailyLossPercent: number;
  realizedPnLJPY: number;
  unrealizedPnLJPY: number;
  netPnLJPY: number;
  lossPatterns: LossPattern[];
  positionPlans: PositionStrategyPlan[];
  globalRules: string[];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pairStats(pair: string, trades: TradeRecord[]) {
  const sells = trades.filter((t) => t.pair === pair && t.side === "sell" && t.pnl !== undefined);
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = sells.filter((t) => (t.pnl ?? 0) < 0).length;
  const pnl = sells.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  return {
    closed: sells.length,
    wins,
    losses,
    pnl,
    winRate: sells.length > 0 ? wins / sells.length : null,
  };
}

function priceContext(position: Position, ticker: TickerData | undefined) {
  const currentPrice = ticker?.price && ticker.price > 0 ? ticker.price : position.currentPrice || position.avgEntryPrice;
  const valueJPY = position.amount * currentPrice;
  const unrealizedPnLJPY = (currentPrice - position.avgEntryPrice) * position.amount;
  const unrealizedPnLPercent = position.avgEntryPrice > 0
    ? ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100
    : 0;
  return { currentPrice, valueJPY, unrealizedPnLJPY, unrealizedPnLPercent };
}

function buildPlans(input: {
  position: Position;
  ticker?: TickerData;
  mtf: MultiTimeframeAnalysis | null;
  trades: TradeRecord[];
  dailyLossPercent: number;
  isTopLossPair: boolean;
}): PositionStrategyPlan {
  const ctx = priceContext(input.position, input.ticker);
  const stats = pairStats(input.position.pair, input.trades);
  const mtf = input.mtf;
  const losing = ctx.unrealizedPnLPercent < 0;
  const deepLoss = ctx.unrealizedPnLPercent <= -2.5;
  const shortWeak = mtf?.short.score !== undefined && mtf.short.score > 20;
  const mediumWeak = mtf?.medium.score !== undefined && mtf.medium.score > 15;
  const longValue = mtf?.long.label === "DEEP_VALUE" || mtf?.long.label === "VALUE";
  const bottoming = Boolean(mtf?.bottomFishing || (longValue && (mtf?.short.score ?? 0) >= (mtf?.medium.score ?? 0) - 5));

  const posture: PositionStrategyPlan["posture"] = !losing
    ? "COMPOUND"
    : deepLoss || input.dailyLossPercent > 1.2 || input.isTopLossPair
    ? "PROTECT"
    : "REPAIR";

  const shortAction: StrategyAction = !losing
    ? "HOLD"
    : deepLoss && shortWeak
    ? "REDUCE"
    : "WAIT";
  const mediumAction: StrategyAction = losing && bottoming && input.dailyLossPercent < 1.2 && !input.isTopLossPair
    ? "ADD_SMALL"
    : losing && mediumWeak
    ? "WAIT"
    : "HOLD";
  const longAction: StrategyAction = losing && longValue
    ? "HOLD"
    : losing && !longValue && mediumWeak
    ? "REDUCE"
    : "HOLD";

  const confidenceBase = stats.closed >= 5 && stats.winRate !== null
    ? clamp(Math.round(stats.winRate * 100), 35, 80)
    : 55;
  const pnlText = `${ctx.unrealizedPnLPercent >= 0 ? "+" : ""}${ctx.unrealizedPnLPercent.toFixed(2)}%`;

  const rules: string[] = [];
  if (input.dailyLossPercent >= 1.2) rules.push("日次損失が大きい日はナンピン禁止");
  if (input.isTopLossPair) rules.push("損失集中ペアのため新規追加は原則停止");
  if (deepLoss) rules.push("含み損が深いので短期反発待ち。反発なしの追加買いは禁止");
  if (bottoming && losing && input.dailyLossPercent < 1.2 && !input.isTopLossPair) {
    rules.push("長期割安かつ短期改善なら小さく平均単価改善を検討");
  }
  if (!losing) rules.push("利益側は段階利確とトレーリングSLを優先");

  return {
    pair: input.position.pair,
    currentPrice: ctx.currentPrice,
    entryPrice: input.position.avgEntryPrice,
    valueJPY: Math.round(ctx.valueJPY),
    unrealizedPnLJPY: Math.round(ctx.unrealizedPnLJPY),
    unrealizedPnLPercent: Number(ctx.unrealizedPnLPercent.toFixed(2)),
    mtf,
    posture,
    plans: [
      {
        horizon: "short",
        label: "短期 15分-4時間",
        action: shortAction,
        confidence: shortAction === "REDUCE" ? 72 : confidenceBase,
        thesis: losing
          ? `現在 ${pnlText}。短期は損失拡大を止める時間軸。反発確認まで新規追加は急がない`
          : `現在 ${pnlText}。短期は利益保護。急騰時は部分利確を優先`,
        invalidation: "短期スコア悪化、またはATR/VaR超えの急落",
      },
      {
        horizon: "medium",
        label: "中期 1-7日",
        action: mediumAction,
        confidence: mediumAction === "ADD_SMALL" ? 68 : confidenceBase,
        thesis: bottoming
          ? "長期割安と短期改善が重なるなら、サイズを絞って回復シナリオを狙う"
          : "中期の優位性が揃うまでは平均単価改善より資金温存を優先",
        invalidation: "中期スコアがPRICEY/OVERVALUED側へ悪化、または出来高を伴う下抜け",
      },
      {
        horizon: "long",
        label: "長期 数週間+",
        action: longAction,
        confidence: longValue ? 70 : 55,
        thesis: longValue
          ? "長期では割安圏。短期の損切りだけで長期シナリオを捨てない"
          : "長期優位性が薄い。資金拘束が続く場合は縮小候補",
        invalidation: "長期FAIR以下を回復できず、同ペアの累計期待値がマイナス継続",
      },
    ],
    rules,
  };
}

export function buildAdaptiveStrategyReport(input: {
  positions: Position[];
  trades: TradeRecord[];
  audits: DecisionAudit[];
  dailyPnL: DailyPnL;
  market: Record<string, { ticker?: TickerData; hourlyBars?: OHLCVBar[]; fourHourBars?: OHLCVBar[]; dailyBars?: OHLCVBar[] }>;
}): AdaptiveStrategyReport {
  const lossAnalysis = analyzeLossPatterns(input.trades, input.audits);
  const topLossPair = lossAnalysis.topPair?.pair ?? null;
  const dailyLossPercent = input.dailyPnL.startCapitalJPY > 0
    ? Math.abs(Math.min(0, input.dailyPnL.totalPnL) / input.dailyPnL.startCapitalJPY) * 100
    : 0;

  const positionPlans = input.positions.map((position) => {
    const market = input.market[position.pair] ?? {};
    const mtf = market.hourlyBars && market.hourlyBars.length >= 50 && market.fourHourBars && market.fourHourBars.length >= 50 && market.dailyBars && market.dailyBars.length >= 50
      ? analyzeMultiTimeframe({
          hourlyBars: market.hourlyBars,
          fourHourBars: market.fourHourBars,
          dailyBars: market.dailyBars,
        })
      : null;
    return buildPlans({
      position,
      ticker: market.ticker,
      mtf,
      trades: input.trades,
      dailyLossPercent,
      isTopLossPair: topLossPair === position.pair,
    });
  });

  const unrealizedPnLJPY = positionPlans.reduce((sum, plan) => sum + plan.unrealizedPnLJPY, 0);
  const netPnLJPY = input.dailyPnL.realizedPnL + unrealizedPnLJPY;
  const portfolioPosture: AdaptiveStrategyReport["portfolioPosture"] = dailyLossPercent >= 1.2 || netPnLJPY < 0
    ? "DEFENSIVE"
    : positionPlans.some((p) => p.plans.some((plan) => plan.action === "ADD_SMALL"))
    ? "RECOVERY"
    : "GROWTH";

  const globalRules: string[] = [
    "24時間稼働: 短期は毎サイクル、中期は数時間ごと、長期は日次で戦略を更新",
    "負けている時ほどポジション追加は小さく、根拠は中期/長期の一致を必須にする",
    "損失原因が集中しているペアはサイズを落とし、勝ちパターンが戻るまで待つ",
  ];
  if (dailyLossPercent >= 1.2) globalRules.unshift("本日は防御優先。新規BUY/追加BUYは原則停止");
  if (lossAnalysis.patterns.length > 0) globalRules.push(`直近の最大課題: ${lossAnalysis.patterns[0].finding}`);

  return {
    generatedAt: new Date().toISOString(),
    portfolioPosture,
    dailyLossPercent: Number(dailyLossPercent.toFixed(2)),
    realizedPnLJPY: Math.round(input.dailyPnL.realizedPnL),
    unrealizedPnLJPY: Math.round(unrealizedPnLJPY),
    netPnLJPY: Math.round(netPnLJPY),
    lossPatterns: lossAnalysis.patterns.slice(0, 5),
    positionPlans,
    globalRules,
  };
}
