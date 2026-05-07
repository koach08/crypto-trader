import type { CircuitBreakerState, DailyPnL } from "../types";
import { loadData, saveData } from "../data";

export class RiskManager {
  private dailyPnL: DailyPnL;
  private maxDailyLossPercent: number;

  constructor(maxDailyLossPercent = 2.0) {
    this.maxDailyLossPercent = maxDailyLossPercent;
    this.dailyPnL = this.getEmptyDay();
  }

  private getEmptyDay(): DailyPnL {
    return {
      date: new Date().toISOString().split("T")[0],
      startCapitalJPY: 0,
      currentCapitalJPY: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      circuitBreakerTriggered: false,
    };
  }

  /** Load saved data without day-transition logic (for API display when bot is stopped) */
  async loadSaved(): Promise<void> {
    const saved = await loadData<DailyPnL>("daily-pnl-current", this.getEmptyDay());
    this.dailyPnL = saved;
  }

  async init(currentCapitalJPY: number): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const saved = await loadData<DailyPnL>("daily-pnl-current", this.getEmptyDay());

    if (saved.date === today) {
      this.dailyPnL = saved;
      // Fix: if startCapitalJPY was saved as 0, repair it with the actual capital
      if (this.dailyPnL.startCapitalJPY === 0 && currentCapitalJPY > 0) {
        this.dailyPnL.startCapitalJPY = currentCapitalJPY;
        this.dailyPnL.currentCapitalJPY = currentCapitalJPY;
        await this.save();
      }
    } else {
      this.dailyPnL = {
        ...this.getEmptyDay(),
        startCapitalJPY: currentCapitalJPY,
        currentCapitalJPY,
      };
      await this.save();
    }
  }

  /** 日付が変わったら dailyPnL をリセット。Bot起動中の0時跨ぎに対応。 */
  async rolloverIfNewDay(currentCapitalJPY: number): Promise<boolean> {
    const today = new Date().toISOString().split("T")[0];
    if (this.dailyPnL.date === today) return false;

    this.dailyPnL = {
      ...this.getEmptyDay(),
      startCapitalJPY: currentCapitalJPY,
      currentCapitalJPY,
    };
    await this.save();
    return true;
  }

  /** 取引履歴から今日分のみ再計算してdailyPnLを正規化。
   *  既存データが起動以来の累積になっている場合の修復用 */
  async recomputeDailyFromTrades(
    trades: { timestamp: string; side: string; pnl?: number }[]
  ): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const todayTrades = trades.filter(
      (t) =>
        t.timestamp.startsWith(today) &&
        t.side === "sell" &&
        t.pnl !== undefined
    );

    this.dailyPnL.date = today;
    this.dailyPnL.realizedPnL = todayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    this.dailyPnL.trades = todayTrades.length;
    this.dailyPnL.wins = todayTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    this.dailyPnL.losses = todayTrades.filter((t) => (t.pnl ?? 0) < 0).length;
    this.dailyPnL.totalPnL = this.dailyPnL.realizedPnL + this.dailyPnL.unrealizedPnL;
    if (this.dailyPnL.startCapitalJPY > 0) {
      this.dailyPnL.totalPnLPercent =
        (this.dailyPnL.totalPnL / this.dailyPnL.startCapitalJPY) * 100;
    }
    await this.save();
  }

  getState(): CircuitBreakerState {
    if (this.dailyPnL.circuitBreakerTriggered) return "TRIGGERED";
    const lossPercent = this.dailyPnL.startCapitalJPY > 0
      ? (Math.abs(Math.min(0, this.dailyPnL.realizedPnL)) / this.dailyPnL.startCapitalJPY) * 100
      : 0;

    if (lossPercent >= this.maxDailyLossPercent) return "TRIGGERED";
    if (lossPercent >= this.maxDailyLossPercent * 0.75) return "WARNING";
    return "ACTIVE";
  }

  isCircuitBroken(): boolean {
    const state = this.getState();
    return state === "TRIGGERED" || state === "MANUAL_STOP";
  }

  calculatePositionSizeJPY(
    confidence: number,
    totalCapitalJPY: number,
    currentPositionJPY: number,
    maxPositionJPY: number
  ): number {
    if (this.isCircuitBroken()) return 0;

    const state = this.getState();
    const basePercent = state === "WARNING" ? 1.5 : 3;
    const baseAmount = totalCapitalJPY * (basePercent / 100);
    const scaledAmount = baseAmount * (confidence / 100);
    const remainingCapacity = Math.max(0, maxPositionJPY - currentPositionJPY);
    const dailyBudget = this.getRemainingDailyBudget(totalCapitalJPY);

    return Math.min(scaledAmount, remainingCapacity, dailyBudget);
  }

  getRemainingDailyBudget(totalCapital: number): number {
    const maxLoss = totalCapital * (this.maxDailyLossPercent / 100);
    const usedLoss = Math.abs(Math.min(0, this.dailyPnL.realizedPnL));
    return Math.max(0, maxLoss - usedLoss);
  }

  recordTrade(pnl: number): void {
    this.dailyPnL.trades++;
    this.dailyPnL.realizedPnL += pnl;
    this.dailyPnL.totalPnL = this.dailyPnL.realizedPnL + this.dailyPnL.unrealizedPnL;
    if (this.dailyPnL.startCapitalJPY > 0) {
      this.dailyPnL.totalPnLPercent = (this.dailyPnL.totalPnL / this.dailyPnL.startCapitalJPY) * 100;
    }
    if (pnl > 0) this.dailyPnL.wins++;
    else if (pnl < 0) this.dailyPnL.losses++;

    if (this.getState() === "TRIGGERED") {
      this.dailyPnL.circuitBreakerTriggered = true;
    }
  }

  updateUnrealizedPnL(pnl: number): void {
    this.dailyPnL.unrealizedPnL = pnl;
    this.dailyPnL.totalPnL = this.dailyPnL.realizedPnL + pnl;
  }

  getDailyPnL(): DailyPnL {
    return { ...this.dailyPnL };
  }

  async save(): Promise<void> {
    await saveData("daily-pnl-current", this.dailyPnL);
  }

  triggerManualStop(): void {
    this.dailyPnL.circuitBreakerTriggered = true;
  }

  reset(): void {
    this.dailyPnL.circuitBreakerTriggered = false;
  }
}
