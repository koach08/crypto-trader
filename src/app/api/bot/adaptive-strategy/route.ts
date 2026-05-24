import { NextResponse } from "next/server";
import { getAudits } from "@/lib/quant/audit-log";
import { buildAdaptiveStrategyReport } from "@/lib/quant/adaptive-strategy";
import { getExchange } from "@/lib/exchanges/factory";
import { ensureReady, getBotStatus, getDailyPnL, getPositions, getTrades } from "@/lib/trading/engine";

export async function GET() {
  await ensureReady();

  const exchange = getExchange();
  await exchange.connect();
  const positions = getPositions();
  const pairs = Array.from(new Set([...getBotStatus().activePairs, ...positions.map((p) => p.pair)]));

  const marketEntries = await Promise.all(
    pairs.map(async (pair) => {
      try {
        const [ticker, hourlyBars, fourHourBars, dailyBars] = await Promise.all([
          exchange.getTicker(pair).catch(() => undefined),
          exchange.getOHLCV(pair, "1h", 100).catch(() => undefined),
          exchange.getOHLCV(pair, "4h", 100).catch(() => undefined),
          exchange.getOHLCV(pair, "1d", 100).catch(() => undefined),
        ]);
        return [pair, { ticker, hourlyBars, fourHourBars, dailyBars }] as const;
      } catch {
        return [pair, {}] as const;
      }
    }),
  );

  const report = buildAdaptiveStrategyReport({
    positions,
    trades: getTrades(),
    audits: await getAudits(500),
    dailyPnL: getDailyPnL(),
    market: Object.fromEntries(marketEntries),
  });

  return NextResponse.json(report);
}
