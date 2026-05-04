import ccxt, { type Exchange as CcxtExchange } from "ccxt";
import type { IExchange } from "./types";
import type { TickerData, OHLCVBar, Balance, OrderResult, ExchangeConfig } from "../types";

/**
 * Generic ccxt-based exchange implementation.
 * Works for any ccxt-supported exchange (binancejp, bitbank, bybit, etc.)
 */
export class CcxtGenericExchange implements IExchange {
  id: string;
  protected exchange: CcxtExchange;
  protected config: ExchangeConfig;

  constructor(config: ExchangeConfig) {
    this.id = config.id;
    this.config = config;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exchanges = ccxt as any;
    const ExchangeClass = exchanges[config.id];
    if (!ExchangeClass) {
      throw new Error(`ccxt does not support exchange: ${config.id}`);
    }

    this.exchange = new ExchangeClass({
      apiKey: config.apiKey,
      secret: config.secret,
      options: { defaultType: "spot" },
    });

    if (config.sandbox) {
      this.exchange.setSandboxMode(true);
    }
  }

  async connect(): Promise<void> {
    await this.exchange.loadMarkets();
  }

  async getTicker(pair: string): Promise<TickerData> {
    const ticker = await this.exchange.fetchTicker(pair);
    const price = ticker.last ?? 0;
    let high24h = ticker.high ?? 0;
    let low24h = ticker.low ?? 0;
    let changePercent24h = ticker.percentage ?? 0;

    // Supplement missing data from OHLCV
    if ((high24h === 0 || low24h === 0) && price > 0) {
      try {
        const bars = await this.getOHLCV(pair, "1h", 24);
        if (bars.length > 0) {
          high24h = Math.max(...bars.map(b => b.high));
          low24h = Math.min(...bars.map(b => b.low));
          const open24h = bars[0].open;
          if (open24h > 0) changePercent24h = ((price - open24h) / open24h) * 100;
        }
      } catch { /* use zeros */ }
    }

    return {
      pair,
      price,
      high24h,
      low24h,
      volume24h: ticker.baseVolume ?? 0,
      changePercent24h,
      timestamp: ticker.timestamp ?? Date.now(),
    };
  }

  async getOHLCV(pair: string, timeframe: string, limit: number): Promise<OHLCVBar[]> {
    // Try native OHLCV first
    if (this.exchange.has.fetchOHLCV) {
      const raw = await this.exchange.fetchOHLCV(pair, timeframe, undefined, limit);
      return raw.map(([ts, o, h, l, c, v]) => ({
        timestamp: ts!, open: o!, high: h!, low: l!, close: c!, volume: v!,
      }));
    }

    // Fallback to CryptoCompare
    const base = pair.split("/")[0];
    const quote = pair.split("/")[1] || "JPY";
    const tfMap: Record<string, string> = {
      "1m": "histominute", "5m": "histominute", "15m": "histominute",
      "1h": "histohour", "4h": "histohour", "1d": "histoday",
    };
    const endpoint = tfMap[timeframe] || "histohour";
    const resp = await fetch(
      `https://min-api.cryptocompare.com/data/v2/${endpoint}?fsym=${base}&tsym=${quote}&limit=${limit}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const json = await resp.json();
    const data = json?.Data?.Data || [];
    return data.map((d: { time: number; open: number; high: number; low: number; close: number; volumefrom: number }) => ({
      timestamp: d.time * 1000, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volumefrom,
    }));
  }

  async getBalance(): Promise<Balance[]> {
    const bal = await this.exchange.fetchBalance();
    const result: Balance[] = [];
    const currencies = ["JPY", "USDT", "BTC", "ETH", "XRP", "SOL", "DOGE", "XLM", "MONA", "MATIC", "ADA", "DOT", "LINK"];

    for (const cur of currencies) {
      const entry = bal[cur];
      if (entry && (entry.total ?? 0) > 0) {
        result.push({
          currency: cur,
          free: entry.free ?? 0,
          used: entry.used ?? 0,
          total: entry.total ?? 0,
        });
      }
    }
    return result;
  }

  async getPosition(pair: string): Promise<{ amount: number; free: number }> {
    const base = pair.split("/")[0];
    const bal = await this.exchange.fetchBalance();
    const entry = bal[base];
    return { amount: entry?.total ?? 0, free: entry?.free ?? 0 };
  }

  async marketBuy(pair: string, amountQuote: number): Promise<OrderResult> {
    const ticker = await this.getTicker(pair);
    const amount = amountQuote / ticker.price;
    const order = await this.exchange.createMarketBuyOrder(pair, amount);
    return {
      id: order.id, pair, side: "buy", type: "market",
      amount: order.amount ?? amount,
      price: order.average ?? ticker.price,
      status: (order.status as OrderResult["status"]) ?? "closed",
      timestamp: order.timestamp ?? Date.now(),
      fee: order.fee?.cost ?? 0,
    };
  }

  async marketSell(pair: string, amountBase: number): Promise<OrderResult> {
    const order = await this.exchange.createMarketSellOrder(pair, amountBase);
    return {
      id: order.id, pair, side: "sell", type: "market",
      amount: order.amount ?? amountBase,
      price: order.average ?? 0,
      status: (order.status as OrderResult["status"]) ?? "closed",
      timestamp: order.timestamp ?? Date.now(),
      fee: order.fee?.cost ?? 0,
    };
  }

  async cancelOrder(orderId: string, pair: string): Promise<boolean> {
    try { await this.exchange.cancelOrder(orderId, pair); return true; } catch { return false; }
  }

  async getOpenOrders(pair: string): Promise<OrderResult[]> {
    const orders = await this.exchange.fetchOpenOrders(pair);
    return orders.map(o => ({
      id: o.id, pair,
      side: (o.side as "buy" | "sell") ?? "buy",
      type: (o.type as "market" | "limit") ?? "limit",
      amount: o.amount ?? 0, price: o.price ?? 0,
      status: (o.status as OrderResult["status"]) ?? "open",
      timestamp: o.timestamp ?? Date.now(),
    }));
  }
}
