import type { TradeRecord, TickerData, AIDecision, Position } from "../types";
import { loadData, saveData } from "../data";

const SLIPPAGE = 0.001; // 0.1%

export class PaperTrader {
  private positions: Map<string, Position> = new Map();
  private trades: TradeRecord[] = [];

  async init(): Promise<void> {
    const savedTrades = await loadData<TradeRecord[]>("paper-trades", []);
    this.trades = savedTrades;

    const savedPositions = await loadData<Position[]>("paper-positions", []);
    for (const p of savedPositions) {
      this.positions.set(p.pair, p);
    }
  }

  async executeBuy(
    pair: string,
    amountJPY: number,
    ticker: TickerData,
    decision: AIDecision
  ): Promise<TradeRecord> {
    const slippagePrice = ticker.price * (1 + SLIPPAGE);
    const amount = amountJPY / slippagePrice;
    const fee = amountJPY * 0.0015; // 0.15% fee estimate

    const trade: TradeRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      exchange: "bitflyer",
      pair,
      side: "buy",
      type: "market",
      amount,
      price: slippagePrice,
      valueJPY: amountJPY,
      orderId: `paper-${Date.now()}`,
      fee,
      paperTrade: true,
      aiDecision: decision,
    };

    // Update position
    const existing = this.positions.get(pair);
    if (existing) {
      const totalAmount = existing.amount + amount;
      const totalCost = existing.avgEntryPrice * existing.amount + slippagePrice * amount;
      existing.amount = totalAmount;
      existing.avgEntryPrice = totalCost / totalAmount;
      existing.currentPrice = ticker.price;
      existing.valueJPY = totalAmount * ticker.price;
      existing.unrealizedPnL = (ticker.price - existing.avgEntryPrice) * totalAmount;
      existing.unrealizedPnLPercent = ((ticker.price - existing.avgEntryPrice) / existing.avgEntryPrice) * 100;
    } else {
      this.positions.set(pair, {
        pair,
        exchange: "bitflyer",
        amount,
        avgEntryPrice: slippagePrice,
        currentPrice: ticker.price,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        valueJPY: amount * ticker.price,
        stopLoss: decision.suggestedStopLossPercent
          ? slippagePrice * (1 - decision.suggestedStopLossPercent / 100) : undefined,
        takeProfit: decision.suggestedTakeProfitPercent
          ? slippagePrice * (1 + decision.suggestedTakeProfitPercent / 100) : undefined,
        entryTimestamp: new Date().toISOString(),
      });
    }

    this.trades.push(trade);
    await this.save();
    return trade;
  }

  async executeSell(
    pair: string,
    ticker: TickerData,
    decision: AIDecision,
    type: "market" | "stop_loss" | "take_profit" = "market"
  ): Promise<TradeRecord | null> {
    const position = this.positions.get(pair);
    if (!position || position.amount <= 0) return null;

    const slippagePrice = ticker.price * (1 - SLIPPAGE);
    const valueJPY = position.amount * slippagePrice;
    const fee = valueJPY * 0.0015;
    const pnl = (slippagePrice - position.avgEntryPrice) * position.amount;
    const pnlPercent = ((slippagePrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;

    const trade: TradeRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      exchange: "bitflyer",
      pair,
      side: "sell",
      type,
      amount: position.amount,
      price: slippagePrice,
      valueJPY,
      orderId: `paper-${Date.now()}`,
      fee,
      pnl,
      pnlPercent,
      paperTrade: true,
      aiDecision: decision,
    };

    this.positions.delete(pair);
    this.trades.push(trade);
    await this.save();
    return trade;
  }

  checkStopLossTakeProfit(pair: string, currentPrice: number): "stop_loss" | "take_profit" | null {
    const position = this.positions.get(pair);
    if (!position) return null;

    if (position.stopLoss && currentPrice <= position.stopLoss) return "stop_loss";
    if (position.takeProfit && currentPrice >= position.takeProfit) return "take_profit";
    return null;
  }

  getPosition(pair: string): Position | null {
    return this.positions.get(pair) ?? null;
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getTrades(): TradeRecord[] {
    return this.trades;
  }

  /** Update current price and unrealized P&L for a position */
  async updatePositionPrice(pair: string, currentPrice: number): Promise<void> {
    const position = this.positions.get(pair);
    if (!position) return;

    position.currentPrice = currentPrice;
    position.valueJPY = position.amount * currentPrice;
    position.unrealizedPnL = (currentPrice - position.avgEntryPrice) * position.amount;
    position.unrealizedPnLPercent = ((currentPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;
    await this.save();
  }

  /** Get total unrealized P&L across all positions */
  getTotalUnrealizedPnL(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.unrealizedPnL;
    }
    return total;
  }

  private async save(): Promise<void> {
    await saveData("paper-trades", this.trades.slice(-1000));
    await saveData("paper-positions", Array.from(this.positions.values()));
  }
}
