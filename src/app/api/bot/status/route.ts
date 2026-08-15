import { NextResponse } from "next/server";
import { getBotStatus, getDecisions, getTrades, getPositions, getDailyPnL, getCumulativePnL, getPortfolioRiskOverlay, ensureReady } from "@/lib/trading/engine";
import { getExchange } from "@/lib/exchanges/factory";

export async function GET() {
  await ensureReady();

  // Current actual exchange free cash (important for "why only 18k allocatable?")
  let jpyBalance = { free: 0, used: 0, total: 0 };
  try {
    const ex = getExchange();
    await ex.connect();
    const bals = await ex.getBalance();
    const j = bals.find(b => b.currency === "JPY");
    if (j) jpyBalance = { free: j.free ?? 0, used: j.used ?? 0, total: j.total ?? 0 };
  } catch {}

  return NextResponse.json({
    status: getBotStatus(),
    positions: getPositions(),
    dailyPnL: getDailyPnL(),
    cumulativePnL: getCumulativePnL(),
    riskOverlay: getPortfolioRiskOverlay(),
    recentDecisions: getDecisions().slice(-10),
    recentTrades: getTrades().slice(-20),
    jpyBalance,   // <-- added for clarity
  });
}
