import ccxt, { type Exchange as CcxtExchange } from "ccxt";
import type { IExchange, ExecutionRecord } from "./types";
import type { TickerData, OHLCVBar, Balance, OrderResult, ExchangeConfig } from "../types";

export class BitFlyerExchange implements IExchange {
  id = "bitflyer";
  private exchange: CcxtExchange;
  private config: ExchangeConfig;

  constructor(config: ExchangeConfig) {
    this.config = config;
    this.exchange = new ccxt.bitflyer({
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
    let high24h = ticker.high ?? 0;
    let low24h = ticker.low ?? 0;
    let changePercent24h = ticker.percentage ?? 0;
    const price = ticker.last ?? 0;

    // bitFlyer often returns 0 for high/low/percentage — supplement from OHLCV
    if ((high24h === 0 || low24h === 0) && price > 0) {
      try {
        const bars = await this.getOHLCV(pair, "1h", 24);
        if (bars.length > 0) {
          high24h = Math.max(...bars.map(b => b.high));
          low24h = Math.min(...bars.map(b => b.low));
          const open24h = bars[0].open;
          if (open24h > 0) {
            changePercent24h = ((price - open24h) / open24h) * 100;
          }
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
    // bitFlyer doesn't support OHLCV via ccxt, fall back to CryptoCompare
    const base = pair.split("/")[0];
    const quote = pair.split("/")[1] || "JPY";

    const tfMap: Record<string, string> = {
      "1m": "histominute", "5m": "histominute", "15m": "histominute",
      "1h": "histohour", "4h": "histohour", "1d": "histoday",
    };
    const endpoint = tfMap[timeframe] || "histohour";

    const params = new URLSearchParams({
      fsym: base, tsym: quote, limit: String(limit),
    });

    // Try CryptoCompare with retry, then fallback to CoinGecko
    const data = await this.fetchOHLCVWithFallback(endpoint, params, base, quote, limit);

    return data
      .map((d: { time: number; open: number; high: number; low: number; close: number; volumefrom: number }) => ({
        timestamp: d.time * 1000,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volumefrom,
      }))
      .filter((b: OHLCVBar) => b.close > 0 && b.open > 0);
  }

  private async fetchOHLCVWithFallback(
    endpoint: string,
    params: URLSearchParams,
    base: string,
    quote: string,
    limit: number
  ): Promise<{ time: number; open: number; high: number; low: number; close: number; volumefrom: number }[]> {
    // Attempt 1 & 2: CryptoCompare with retry
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(
          `https://min-api.cryptocompare.com/data/v2/${endpoint}?${params}`,
          { signal: AbortSignal.timeout(30000) }
        );
        const json = await resp.json();
        const data = json?.Data?.Data || [];
        if (data.length > 0 && data.some((d: { close: number }) => d.close > 0)) {
          return data;
        }
      } catch (e) {
        // CryptoCompare retry - silent
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }

    // Fallback 1: CoinGecko (Railway IPはレート制限されやすい)
    try {
      const cgId = base === "BTC" ? "bitcoin" : base === "ETH" ? "ethereum" : base === "XRP" ? "ripple" : base.toLowerCase();
      const cgQuote = quote.toLowerCase();
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=${cgQuote}&days=4`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (resp.ok) {
        const ohlc = await resp.json();
        if (Array.isArray(ohlc) && ohlc.length > 0) {
          return ohlc.slice(-limit).map((bar: number[]) => ({
            time: Math.floor(bar[0] / 1000),
            open: bar[1],
            high: bar[2],
            low: bar[3],
            close: bar[4],
            volumefrom: 0,
          }));
        }
      }
    } catch { /* fall through */ }

    // Fallback 2: Yahoo Finance (Railway IPで動作確認済み)
    try {
      const symbol = `${base}-${quote}`;
      const range = "1mo";
      const interval = "1h";
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
        {
          signal: AbortSignal.timeout(15000),
          headers: { "User-Agent": "Mozilla/5.0 crypto-trader" },
        }
      );
      if (!resp.ok) return [];
      const json = await resp.json();
      const r = json?.chart?.result?.[0];
      if (!r) return [];
      const ts: number[] = r.timestamp ?? [];
      const q = r.indicators?.quote?.[0];
      if (!q) return [];
      const bars: { time: number; open: number; high: number; low: number; close: number; volumefrom: number }[] = [];
      for (let i = 0; i < ts.length; i++) {
        const close = q.close?.[i];
        if (close == null) continue;
        bars.push({
          time: ts[i],
          open: q.open?.[i] ?? close,
          high: q.high?.[i] ?? close,
          low: q.low?.[i] ?? close,
          close,
          volumefrom: q.volume?.[i] ?? 0,
        });
      }
      if (bars.length > 0) {
        console.log(`[bitflyer] Yahoo fallback for ${base}/${quote}: ${bars.length} bars`);
        return bars.slice(-limit);
      }
    } catch { /* return empty */ }

    return [];
  }

  async getBalance(): Promise<Balance[]> {
    const bal = await this.exchange.fetchBalance();
    const result: Balance[] = [];
    const currencies = ["JPY", "BTC", "ETH", "XRP", "XLM", "MONA"];

    for (const cur of currencies) {
      const entry = bal[cur];
      if (entry) {
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
    return {
      amount: entry?.total ?? 0,
      free: entry?.free ?? 0,
    };
  }

  // BitFlyer精度要件に合わせて数量を丸める
  private roundAmount(pair: string, amount: number): number {
    const base = pair.split("/")[0];
    const precisionMap: Record<string, number> = {
      BTC: 8, ETH: 7, XRP: 6, XLM: 6, MONA: 6,
    };
    const minAmountMap: Record<string, number> = {
      BTC: 0.001, ETH: 0.01, XRP: 0.1, XLM: 0.1, MONA: 0.1,
    };
    const precision = precisionMap[base] ?? 8;
    const minAmount = minAmountMap[base] ?? 0.001;
    const factor = Math.pow(10, precision);
    const rounded = Math.floor(amount * factor) / factor;
    return rounded >= minAmount ? rounded : 0;
  }

  async marketBuy(pair: string, amountQuote: number): Promise<OrderResult> {
    const ticker = await this.getTicker(pair);
    const rawAmount = amountQuote / ticker.price;
    const amount = this.roundAmount(pair, rawAmount);

    if (amount <= 0) {
      throw new Error(`${pair}: 注文額が最小取引単位未満 (¥${amountQuote.toLocaleString()})`);
    }

    const order = await this.exchange.createMarketBuyOrder(pair, amount);
    return {
      id: order.id,
      pair,
      side: "buy",
      type: "market",
      amount: order.amount ?? amount,
      price: order.average ?? ticker.price,
      status: (order.status as OrderResult["status"]) ?? "closed",
      timestamp: order.timestamp ?? Date.now(),
      fee: order.fee?.cost ?? 0,
    };
  }

  async marketSell(pair: string, amountBase: number): Promise<OrderResult> {
    // BitFlyer は free 残高をピタリ送ると内部精度ズレで "Insufficient funds" を返すことがある。
    // 段階的に buffer を増やしてリトライ: 0.5% → 1% → 2% → 5%
    const base = pair.split("/")[0];
    const minAmountMap: Record<string, number> = {
      BTC: 0.001, ETH: 0.01, XRP: 0.1, XLM: 0.1, MONA: 0.1,
    };
    const minAmount = minAmountMap[base] ?? 0.001;

    const buffers = [0.995, 0.99, 0.98, 0.95];
    let lastError: unknown = null;
    for (const buffer of buffers) {
      const safeAmount = Math.max(amountBase * buffer, minAmount);
      const amount = this.roundAmount(pair, safeAmount);
      if (amount <= 0) continue;

      try {
        console.log(`[bitflyer] marketSell ${pair}: 要求${amountBase} buffer=${(1 - buffer) * 100}% → 送信${amount}`);
        const order = await this.exchange.createMarketSellOrder(pair, amount);
        return {
          id: order.id,
          pair,
          side: "sell",
          type: "market",
          amount: order.amount ?? amount,
          price: order.average ?? 0,
          status: (order.status as OrderResult["status"]) ?? "closed",
          timestamp: order.timestamp ?? Date.now(),
          fee: order.fee?.cost ?? 0,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Insufficient funds")) {
          console.log(`[bitflyer] ${pair}: buffer ${(1 - buffer) * 100}% でも Insufficient、次のbufferへ`);
          lastError = e;
          continue;
        }
        // Insufficient 以外のエラーは即throw
        throw e;
      }
    }
    throw lastError ?? new Error(`${pair}: 全bufferで売却失敗`);
  }

  async cancelOrder(orderId: string, pair: string): Promise<boolean> {
    try {
      await this.exchange.cancelOrder(orderId, pair);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * BitFlyer の全約定履歴を取得（/v1/me/getexecutions 経由）。
   * sinceMs を指定するとそれより古い分はスキップ。
   * ページングは ccxt の since/limit と count パラメータでハンドリング。
   */
  async fetchExecutions(pair: string, sinceMs?: number): Promise<ExecutionRecord[]> {
    const out: ExecutionRecord[] = [];
    const PAGE_SIZE = 500;
    // BitFlyer の getexecutions は新しい順に返ってくる。
    // ccxt の fetchMyTrades(symbol, since, limit) は内部で since 以降を要求する。
    // ページング: 'before' ID指定で古い側へ進む。
    let beforeId: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params: Record<string, unknown> = { count: PAGE_SIZE };
      if (beforeId) params.before = beforeId;

      let trades;
      try {
        trades = await this.exchange.fetchMyTrades(pair, undefined, PAGE_SIZE, params);
      } catch (e) {
        console.error(`[bitflyer] fetchMyTrades(${pair}) page ${page} 失敗:`, e);
        break;
      }
      if (!trades || trades.length === 0) break;

      let reachedSince = false;
      for (const t of trades) {
        const ts = t.timestamp ?? 0;
        if (sinceMs && ts && ts < sinceMs) {
          reachedSince = true;
          continue;
        }
        if (!t.side || (t.side !== "buy" && t.side !== "sell")) continue;
        out.push({
          id: String(t.id ?? `${pair}-${ts}-${out.length}`),
          timestamp: ts || Date.now(),
          pair,
          side: t.side,
          amount: t.amount ?? 0,
          price: t.price ?? 0,
          fee: t.fee?.cost ?? 0,
        });
      }

      // 進める ID を取得（ccxtのidは新しい順なので末尾が最古）
      const last = trades[trades.length - 1];
      if (!last?.id) break;
      const nextBefore = String(last.id);
      if (nextBefore === beforeId) break; // ループ防止
      beforeId = nextBefore;

      if (reachedSince || trades.length < PAGE_SIZE) break;
    }

    return out;
  }

  async getOpenOrders(pair: string): Promise<OrderResult[]> {
    const orders = await this.exchange.fetchOpenOrders(pair);
    return orders.map(o => ({
      id: o.id,
      pair,
      side: (o.side as "buy" | "sell") ?? "buy",
      type: (o.type as "market" | "limit") ?? "limit",
      amount: o.amount ?? 0,
      price: o.price ?? 0,
      status: (o.status as OrderResult["status"]) ?? "open",
      timestamp: o.timestamp ?? Date.now(),
    }));
  }
}
