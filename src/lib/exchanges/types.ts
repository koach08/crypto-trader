import type { TickerData, OHLCVBar, Balance, OrderResult } from "../types";

export interface IExchange {
  id: string;
  connect(): Promise<void>;
  getTicker(pair: string): Promise<TickerData>;
  getOHLCV(pair: string, timeframe: string, limit: number): Promise<OHLCVBar[]>;
  getBalance(): Promise<Balance[]>;
  getPosition(pair: string): Promise<{ amount: number; free: number }>;
  marketBuy(pair: string, amountQuote: number): Promise<OrderResult>;
  marketSell(pair: string, amountBase: number): Promise<OrderResult>;
  cancelOrder(orderId: string, pair: string): Promise<boolean>;
  getOpenOrders(pair: string): Promise<OrderResult[]>;
}
