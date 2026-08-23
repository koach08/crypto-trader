/**
 * 生涯損益計算 (FIFO)
 *
 * 取引所の全約定履歴から、ペア毎に FIFO 方式で
 * 買い注文と売り注文を突き合わせ、確定損益を算出する。
 *
 * 用途: ローカルの liveTrades は 200件 rolling で消えるので、
 * BitFlyer の getexecutions から取り直して真の累計を出す。
 */

import { feeToJPY } from "./fee";
import type { ExecutionRecord } from "../exchanges/types";

export interface LifetimePnLByPair {
  pair: string;
  realizedPnL: number;
  buyVolume: number;
  sellVolume: number;
  closedTrades: number;
  wins: number;
  losses: number;
  totalFees: number;
  remainingInventory: number;
  averageBuyPrice: number;
  firstTradeTimestamp: number | null;
  lastTradeTimestamp: number | null;
}

export interface LifetimePnLSummary {
  totalRealizedPnL: number;
  totalFees: number;
  netRealizedPnL: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalBuyVolumeJPY: number;
  totalSellVolumeJPY: number;
  byPair: LifetimePnLByPair[];
  firstTradeTimestamp: number | null;
  lastTradeTimestamp: number | null;
  executionCount: number;
}

interface InventoryLot {
  amount: number;
  cost: number; // unit price (JPY per coin)
}

export function computeLifetimePnL(executions: ExecutionRecord[]): LifetimePnLSummary {
  const sorted = [...executions].sort((a, b) => a.timestamp - b.timestamp);
  const inventory: Record<string, InventoryLot[]> = {};
  const perPair: Record<string, LifetimePnLByPair> = {};

  let totalRealizedPnL = 0;
  let totalFees = 0;
  let closedTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalBuyVolumeJPY = 0;
  let totalSellVolumeJPY = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const e of sorted) {
    if (firstTs === null || e.timestamp < firstTs) firstTs = e.timestamp;
    if (lastTs === null || e.timestamp > lastTs) lastTs = e.timestamp;

    if (!inventory[e.pair]) inventory[e.pair] = [];
    if (!perPair[e.pair]) {
      perPair[e.pair] = {
        pair: e.pair,
        realizedPnL: 0,
        buyVolume: 0,
        sellVolume: 0,
        closedTrades: 0,
        wins: 0,
        losses: 0,
        totalFees: 0,
        remainingInventory: 0,
        averageBuyPrice: 0,
        firstTradeTimestamp: null,
        lastTradeTimestamp: null,
      };
    }

    const stats = perPair[e.pair];
    // 手数料は基軸通貨建てで来る (bitFlyer)。円に直さずに足すと、
    // 売買代金 ¥2,750,000 に対して総手数料 ¥0.19 のような数字になる。
    const feeJPY = feeToJPY({ fee: e.fee, feeCurrency: e.feeCurrency, pair: e.pair, priceJPY: e.price });
    stats.totalFees += feeJPY;
    totalFees += feeJPY;
    if (stats.firstTradeTimestamp === null || e.timestamp < stats.firstTradeTimestamp) {
      stats.firstTradeTimestamp = e.timestamp;
    }
    if (stats.lastTradeTimestamp === null || e.timestamp > stats.lastTradeTimestamp) {
      stats.lastTradeTimestamp = e.timestamp;
    }

    const valueJPY = e.amount * e.price;
    if (e.side === "buy") {
      inventory[e.pair].push({ amount: e.amount, cost: e.price });
      stats.buyVolume += valueJPY;
      totalBuyVolumeJPY += valueJPY;
    } else {
      stats.sellVolume += valueJPY;
      totalSellVolumeJPY += valueJPY;

      // FIFO match
      let remaining = e.amount;
      let matchedCost = 0;
      while (remaining > 0 && inventory[e.pair].length > 0) {
        const lot = inventory[e.pair][0];
        if (lot.amount <= remaining + 1e-12) {
          matchedCost += lot.amount * lot.cost;
          remaining -= lot.amount;
          inventory[e.pair].shift();
        } else {
          matchedCost += remaining * lot.cost;
          lot.amount -= remaining;
          remaining = 0;
        }
      }
      const matchedSize = e.amount - remaining;
      if (matchedSize > 0) {
        // 売却収入 - 取得コスト - 手数料 (円に直したもの)
        const sellFeeJPY = feeToJPY({ fee: e.fee, feeCurrency: e.feeCurrency, pair: e.pair, priceJPY: e.price });
        const pnl = matchedSize * e.price - matchedCost - sellFeeJPY;
        totalRealizedPnL += pnl;
        stats.realizedPnL += pnl;
        stats.closedTrades += 1;
        closedTrades += 1;
        if (pnl > 0) {
          stats.wins += 1;
          wins += 1;
        } else if (pnl < 0) {
          stats.losses += 1;
          losses += 1;
        }
      }
    }
  }

  // 残在庫量と平均取得単価
  for (const pair of Object.keys(perPair)) {
    const lots = inventory[pair] ?? [];
    const remaining = lots.reduce((s, l) => s + l.amount, 0);
    const cost = lots.reduce((s, l) => s + l.amount * l.cost, 0);
    perPair[pair].remainingInventory = remaining;
    perPair[pair].averageBuyPrice = remaining > 0 ? cost / remaining : 0;
  }

  return {
    totalRealizedPnL,
    totalFees,
    netRealizedPnL: totalRealizedPnL, // pnl は既に手数料控除済み
    closedTrades,
    wins,
    losses,
    winRate: closedTrades > 0 ? (wins / closedTrades) * 100 : 0,
    totalBuyVolumeJPY,
    totalSellVolumeJPY,
    byPair: Object.values(perPair).sort((a, b) => Math.abs(b.realizedPnL) - Math.abs(a.realizedPnL)),
    firstTradeTimestamp: firstTs,
    lastTradeTimestamp: lastTs,
    executionCount: sorted.length,
  };
}
