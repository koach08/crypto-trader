import type { AIDecision, DailyPnL, InstitutionalRiskReport, OHLCVBar, PortfolioRiskOverlay, Position } from "../types";
import { atr } from "../indicators";

type Action = AIDecision["action"];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1)];
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0] ?? 0;
  let maxDd = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    if (peak > 0) maxDd = Math.min(maxDd, (close - peak) / peak);
  }
  return Math.abs(maxDd) * 100;
}

function atrPercent(bars: OHLCVBar[]): number {
  const values = atr(
    bars.map((b) => b.high),
    bars.map((b) => b.low),
    bars.map((b) => b.close),
    14,
  );
  const latest = [...values].reverse().find((v): v is number => v !== null) ?? 0;
  const price = bars[bars.length - 1]?.close ?? 0;
  return price > 0 ? (latest / price) * 100 : 0;
}

export function assessPreTradeRisk(input: {
  bars: OHLCVBar[];
  action: Action;
  confidence: number;
  regime: string;
  totalCapitalJPY: number;
  currentPositionJPY: number;
  maxPositionJPY: number;
  dailyPnL: DailyPnL;
  tradingDaysPerYear?: number;
}): InstitutionalRiskReport {
  const closes = input.bars.map((b) => b.close).filter((v) => Number.isFinite(v) && v > 0);
  const returns = closes.slice(1).map((close, index) => ((close - closes[index]) / closes[index]) * 100);
  const downside = returns.filter((value) => value < 0);
  const annualizedVolatilityPercent = stdev(returns) * Math.sqrt(input.tradingDaysPerYear ?? 365);
  const valueAtRisk95Percent = Math.abs(percentile(returns, 0.05));
  const tail = downside.filter((value) => value <= -valueAtRisk95Percent);
  const conditionalVaR95Percent = Math.abs(
    tail.length ? tail.reduce((sum, value) => sum + value, 0) / tail.length : -valueAtRisk95Percent,
  );
  const maxDrawdownPercent = maxDrawdown(closes);
  const currentAtrPercent = atrPercent(input.bars);
  const exposurePercent = input.totalCapitalJPY > 0 ? (input.currentPositionJPY / input.totalCapitalJPY) * 100 : 0;
  const openRiskPercent = input.totalCapitalJPY > 0
    ? (input.currentPositionJPY * Math.max(currentAtrPercent, valueAtRisk95Percent) / 100 / input.totalCapitalJPY) * 100
    : 0;
  const dailyLossPercent = input.dailyPnL.startCapitalJPY > 0
    ? Math.abs(Math.min(0, input.dailyPnL.totalPnL) / input.dailyPnL.startCapitalJPY) * 100
    : 0;

  const riskPenalty =
    annualizedVolatilityPercent * 0.35 +
    conditionalVaR95Percent * 5 +
    maxDrawdownPercent * 0.45 +
    exposurePercent * 0.25 +
    openRiskPercent * 6 +
    dailyLossPercent * 8 +
    (input.regime === "VOLATILE" ? 16 : 0);
  const confidenceBoost = clamp(input.confidence - 55, 0, 35) * 0.35;
  const riskScore = Math.round(clamp(100 - riskPenalty + confidenceBoost, 0, 100));

  const warnings: string[] = [];
  if (annualizedVolatilityPercent > 70) warnings.push("年率ボラが高く、通常サイズでは危険");
  if (conditionalVaR95Percent > 5) warnings.push("CVaRが厚い。急落時の損失が想定より大きい");
  if (maxDrawdownPercent > 35) warnings.push("直近履歴の最大ドローダウンが大きい");
  if (exposurePercent > 35) warnings.push("同一銘柄/ペアへの集中が大きい");
  if (dailyLossPercent > 1.5) warnings.push("本日損失が拡大中。新規エントリーを抑制");
  if (input.regime === "VOLATILE") warnings.push("高ボラレジーム。縮小または待機");

  const killSwitch = riskScore < 30 || dailyLossPercent >= 2.5 || conditionalVaR95Percent >= 9;
  const gate = killSwitch ? "AVOID" : riskScore < 60 || warnings.length >= 2 ? "REDUCE_SIZE" : "TRADEABLE";
  const baseMultiplier = gate === "TRADEABLE" ? 1 : gate === "REDUCE_SIZE" ? 0.35 : 0;
  const volMultiplier = clamp(1.2 / Math.max(currentAtrPercent, 0.6), 0.25, 1);
  const sizeMultiplier = Number((baseMultiplier * volMultiplier).toFixed(2));
  const remainingCapacity = Math.max(0, input.maxPositionJPY - input.currentPositionJPY);
  const suggestedMaxTradeJPY = Math.floor(remainingCapacity * sizeMultiplier);
  const maxLossAtSuggestedSizePercent = input.totalCapitalJPY > 0
    ? (suggestedMaxTradeJPY * Math.max(currentAtrPercent, valueAtRisk95Percent) / 100 / input.totalCapitalJPY) * 100
    : 0;

  return {
    gate,
    riskScore,
    sizeMultiplier,
    suggestedMaxTradeJPY,
    annualizedVolatilityPercent: Number(annualizedVolatilityPercent.toFixed(2)),
    valueAtRisk95Percent: Number(valueAtRisk95Percent.toFixed(2)),
    conditionalVaR95Percent: Number(conditionalVaR95Percent.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
    atrPercent: Number(currentAtrPercent.toFixed(2)),
    exposurePercent: Number(exposurePercent.toFixed(2)),
    openRiskPercent: Number(openRiskPercent.toFixed(2)),
    maxLossAtSuggestedSizePercent: Number(maxLossAtSuggestedSizePercent.toFixed(2)),
    killSwitch,
    warnings,
  };
}

export function buildPortfolioRiskOverlay(input: {
  positions: Position[];
  dailyPnL: DailyPnL;
  capitalJPY: number;
  paperMode: boolean;
  recentDecisions: AIDecision[];
}): PortfolioRiskOverlay {
  const exposureJPY = input.positions.reduce((sum, p) => sum + p.valueJPY, 0);
  const exposurePercent = input.capitalJPY > 0 ? (exposureJPY / input.capitalJPY) * 100 : 0;
  const openRiskJPY = input.positions.reduce((sum, p) => {
    if (!p.stopLoss) return sum + p.valueJPY * 0.08;
    return sum + Math.max(0, ((p.avgEntryPrice - p.stopLoss) / p.avgEntryPrice) * p.valueJPY);
  }, 0);
  const openRiskPercent = input.capitalJPY > 0 ? (openRiskJPY / input.capitalJPY) * 100 : 0;
  const dailyLossPercent = input.dailyPnL.startCapitalJPY > 0
    ? Math.abs(Math.min(0, input.dailyPnL.totalPnL) / input.dailyPnL.startCapitalJPY) * 100
    : 0;
  const lowConfidenceTrades = input.recentDecisions.slice(-8).filter((d) => d.action !== "HOLD" && d.confidence < 60).length;

  const warnings: string[] = [];
  if (!input.paperMode) warnings.push("ライブ運用。注文前ゲートを必ず確認");
  if (exposurePercent > 55) warnings.push("総エクスポージャーが大きい");
  if (openRiskPercent > 2) warnings.push("Open Riskが日次許容損失に近い");
  if (dailyLossPercent > 1.5) warnings.push("日次損失が拡大中");
  if (lowConfidenceTrades >= 3) warnings.push("低確信度の取引判断が続いている");

  const riskScore = Math.round(clamp(100 - exposurePercent * 0.55 - openRiskPercent * 12 - dailyLossPercent * 10 - warnings.length * 8, 0, 100));
  const gate = riskScore < 35 || dailyLossPercent >= 2.5 ? "AVOID" : riskScore < 65 || warnings.length ? "REDUCE_SIZE" : "TRADEABLE";

  return {
    gate,
    riskScore,
    exposureJPY,
    exposurePercent: Number(exposurePercent.toFixed(2)),
    openRiskJPY,
    openRiskPercent: Number(openRiskPercent.toFixed(2)),
    dailyLossPercent: Number(dailyLossPercent.toFixed(2)),
    recommendedAction: gate === "AVOID" ? "新規停止・既存ポジション管理のみ" : gate === "REDUCE_SIZE" ? "新規サイズを35%以下に縮小" : "通常運用可",
    warnings,
  };
}
