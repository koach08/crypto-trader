import { NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";
import type { OrderResult } from "@/lib/types";

export async function GET() {
  try {
    const exchange = getExchange();
    await exchange.connect();

    const pairs = ["BTC/JPY", "ETH/JPY", "XRP/JPY", "SOL/JPY"]; // main ones + extend if needed
    const allOrders: (OrderResult & { lockedJPY?: number })[] = [];

    let totalLockedJPY = 0;

    for (const pair of pairs) {
      try {
        const orders = await exchange.getOpenOrders(pair);
        for (const o of orders) {
          let lockedJPY = 0;
          if (o.side === "buy") {
            // buy order locks quote (JPY)
            lockedJPY = (o.amount || 0) * (o.price || 0);
          }
          // for sell, it would lock base asset, not JPY

          if (lockedJPY > 0) {
            totalLockedJPY += lockedJPY;
          }

          allOrders.push({
            ...o,
            lockedJPY: Math.round(lockedJPY),
          });
        }
      } catch (e) {
        // pair may not have orders or error, ignore per pair
      }
    }

    return NextResponse.json({
      orders: allOrders,
      totalLockedJPY: Math.round(totalLockedJPY),
      count: allOrders.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
