import type { TickerData, OHLCVBar, Balance, OrderResult } from "../types";

export interface ExecutionRecord {
  id: string;
  timestamp: number;
  pair: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  fee: number;
}

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
  /** 取引所側の全約定履歴を取得（ページング考慮）。sinceMs より古い分は返さない */
  fetchExecutions?(pair: string, sinceMs?: number): Promise<ExecutionRecord[]>;
  /** ペアと現在価格から「実際に発注可能な最小JPY額」を返す */
  getMinOrderJPY?(pair: string, price: number): number;
  /** Maker-only 指値 BUY (手数料 0%)。約定なければ null */
  limitBuyMakerOnly?(pair: string, amountQuoteJPY: number, timeoutMs?: number): Promise<OrderResult | null>;
  /** Maker-only 指値 SELL (手数料 0%)。約定なければ null */
  limitSellMakerOnly?(pair: string, amountBase: number, timeoutMs?: number): Promise<OrderResult | null>;
}
