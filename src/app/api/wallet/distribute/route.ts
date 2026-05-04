import { NextRequest, NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";
import { loadData } from "@/lib/data";
import type { WalletConfig, OrderResult } from "@/lib/types";

interface DistributeResult {
  pair: string;
  targetJPY: number;
  currentJPY: number;
  buyAmountJPY: number;
  order?: OrderResult;
  error?: string;
  skipped?: string;
}

export async function POST(req: NextRequest) {
  const { dryRun = true, exchangeId = "bitflyer" } = await req.json();

  try {
    const exchange = getExchange(exchangeId);
    await exchange.connect();

    const config = await loadData<WalletConfig>("wallet-config", {
      totalCapitalJPY: 0,
      allocationTargets: [],
      reservePercent: 20,
    });

    if (config.allocationTargets.length === 0) {
      return NextResponse.json({ error: "配分ルール未設定。ウォレット設定で配分を設定してください。" }, { status: 400 });
    }

    // Get current balances
    const balances = await exchange.getBalance();
    const jpyFree = balances.find(b => b.currency === "JPY")?.free ?? 0;

    if (jpyFree < 500) {
      return NextResponse.json({ error: `JPY残高不足: ¥${jpyFree.toLocaleString()}`, jpyFree }, { status: 400 });
    }

    // Calculate reserve
    const reserveJPY = jpyFree * (config.reservePercent / 100);
    const distributableJPY = jpyFree - reserveJPY;

    if (distributableJPY < 500) {
      return NextResponse.json({
        error: `配分可能額が少なすぎます: ¥${distributableJPY.toLocaleString()} (リザーブ${config.reservePercent}%控除後)`,
        jpyFree,
        reserveJPY,
      }, { status: 400 });
    }

    // Calculate current positions value
    const results: DistributeResult[] = [];
    const totalTargetPercent = config.allocationTargets.reduce((s, a) => s + a.targetPercent, 0);

    for (const target of config.allocationTargets) {
      const normalizedPercent = (target.targetPercent / totalTargetPercent) * 100;
      const targetJPY = distributableJPY * (normalizedPercent / 100);

      // Get current position value
      let currentJPY = 0;
      try {
        const pos = await exchange.getPosition(target.pair);
        if (pos.amount > 0) {
          const ticker = await exchange.getTicker(target.pair);
          currentJPY = pos.amount * ticker.price;
        }
      } catch { /* no position */ }

      const buyAmountJPY = Math.max(0, targetJPY - currentJPY);

      // Min order size check
      if (buyAmountJPY < 500) {
        results.push({
          pair: target.pair,
          targetJPY: Math.round(targetJPY),
          currentJPY: Math.round(currentJPY),
          buyAmountJPY: 0,
          skipped: currentJPY >= targetJPY ? "目標達成済み" : "購入額が少なすぎ",
        });
        continue;
      }

      // Cap at max position
      const cappedAmount = Math.min(buyAmountJPY, target.maxPositionJPY - currentJPY);

      if (dryRun) {
        results.push({
          pair: target.pair,
          targetJPY: Math.round(targetJPY),
          currentJPY: Math.round(currentJPY),
          buyAmountJPY: Math.round(cappedAmount),
        });
      } else {
        // Execute real buy
        try {
          const order = await exchange.marketBuy(target.pair, cappedAmount);
          results.push({
            pair: target.pair,
            targetJPY: Math.round(targetJPY),
            currentJPY: Math.round(currentJPY),
            buyAmountJPY: Math.round(cappedAmount),
            order,
          });
        } catch (e) {
          results.push({
            pair: target.pair,
            targetJPY: Math.round(targetJPY),
            currentJPY: Math.round(currentJPY),
            buyAmountJPY: Math.round(cappedAmount),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return NextResponse.json({
      dryRun,
      exchangeId,
      jpyFree: Math.round(jpyFree),
      reserveJPY: Math.round(reserveJPY),
      distributableJPY: Math.round(distributableJPY),
      results,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
