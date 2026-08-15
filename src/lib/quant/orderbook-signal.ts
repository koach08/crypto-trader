/**
 * Orderbook Microstructure Signal (Pro-grade)
 *
 * Pros use book imbalance, spread, depth to detect absorption / aggressive buying.
 * Returns score -100 (heavy sell pressure) to +100 (heavy buy pressure)
 */

import type { IExchange } from "../exchanges/types";

export interface OrderBookSignal {
  score: number;           // -100 ~ +100
  imbalance: number;       // (bidVol - askVol) / (bidVol + askVol)  -1 to +1
  spreadBps: number;       // (ask - bid) / mid * 10000
  topDepthJPY: number;     // liquidity in top levels (JPY)
  available: boolean;
  reason: string;
}

const CACHE = new Map<string, { signal: OrderBookSignal; ts: number }>();
const TTL_MS = 30_000; // 30s cache (book moves fast)

export async function getOrderBookSignal(
  exchange: IExchange,
  pair: string,
  midPrice: number
): Promise<OrderBookSignal> {
  const key = `${exchange.id}:${pair}`;
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return cached.signal;
  }

  if (!exchange.getOrderBook) {
    return { score: 0, imbalance: 0, spreadBps: 0, topDepthJPY: 0, available: false, reason: "no orderbook support" };
  }

  try {
    const book = await exchange.getOrderBook(pair, 15);
    if (!book.bids.length || !book.asks.length) {
      throw new Error("empty book");
    }

    const bidVol = book.bids.reduce((s, [p, q]) => s + p * q, 0);
    const askVol = book.asks.reduce((s, [p, q]) => s + p * q, 0);
    const imbalance = (bidVol - askVol) / (bidVol + askVol + 1e-9);

    const bestBid = book.bids[0][0];
    const bestAsk = book.asks[0][0];
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    const topDepthJPY = Math.min(bidVol, askVol); // conservative liquidity

    // Score: imbalance dominant, penalize wide spread
    let score = imbalance * 80;
    if (spreadBps > 25) score *= 0.6; // wide spread = less reliable
    if (spreadBps > 50) score *= 0.3;

    const signal: OrderBookSignal = {
      score: Math.max(-100, Math.min(100, Math.round(score))),
      imbalance: Number(imbalance.toFixed(3)),
      spreadBps: Number(spreadBps.toFixed(1)),
      topDepthJPY: Math.round(topDepthJPY),
      available: true,
      reason: `imb=${(imbalance*100).toFixed(0)}% spread=${spreadBps.toFixed(0)}bps depth¥${Math.round(topDepthJPY/1000)}k`,
    };

    CACHE.set(key, { signal, ts: Date.now() });
    return signal;
  } catch (e) {
    const fallback = { score: 0, imbalance: 0, spreadBps: 0, topDepthJPY: 0, available: false, reason: "orderbook fetch failed" };
    CACHE.set(key, { signal: fallback, ts: Date.now() });
    return fallback;
  }
}
