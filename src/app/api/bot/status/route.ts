import { NextResponse } from "next/server";
import { getBotStatus, getDecisions, getTrades, getPositions, getDailyPnL, getCumulativePnL, getPortfolioRiskOverlay, getTrendStates, getCoreHoldingReport, ensureReady } from "@/lib/trading/engine";
import { getExchange } from "@/lib/exchanges/factory";
import { getBalanceCached } from "@/lib/trading/engine";

export async function GET() {
  await ensureReady();

  // Current actual exchange free cash (important for "why only 18k allocatable?")
  let jpyBalance = { free: 0, used: 0, total: 0 };
  try {
    const ex = getExchange();
    await ex.connect();
    // 画面は数秒おきにポーリングするので、残高は短期キャッシュで足りる
    const bals = await getBalanceCached(ex);
    const j = bals.find(b => b.currency === "JPY");
    if (j) jpyBalance = { free: j.free ?? 0, used: j.used ?? 0, total: j.total ?? 0 };
  } catch {}

  // コア保有 (売らない長期枠)。トレンドゲートで戦術枠が止まっている間も
  // ここが目標比率まで積み上がっているかを画面で確認できるようにする。
  const coreHolding = await getCoreHoldingReport().catch(() => null);

  return NextResponse.json({
    status: getBotStatus(),
    positions: getPositions(),
    dailyPnL: getDailyPnL(),
    cumulativePnL: getCumulativePnL(),
    riskOverlay: getPortfolioRiskOverlay(),
    recentDecisions: getDecisions().slice(-10),
    recentTrades: getTrades().slice(-20),
    // 「なぜ買っていないのか」を画面で説明できるようにする。
    // 下降トレンド中に新規買いを出さないのは仕様であって不具合ではない。
    trendStates: getTrendStates(),
    jpyBalance,   // <-- added for clarity
    coreHolding,
  });
}
