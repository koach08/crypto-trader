import { NextResponse } from "next/server";
import { getBotStatus, getDecisions, getTrades, getPositions, getDailyPnL, getCumulativePnL, ensureReady } from "@/lib/trading/engine";

export async function GET() {
  await ensureReady();
  return NextResponse.json({
    status: getBotStatus(),
    positions: getPositions(),
    dailyPnL: getDailyPnL(),
    cumulativePnL: getCumulativePnL(),
    recentDecisions: getDecisions().slice(-10),
    recentTrades: getTrades().slice(-20),
  });
}
