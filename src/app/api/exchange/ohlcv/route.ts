import { NextRequest, NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";

export async function GET(req: NextRequest) {
  const pair = req.nextUrl.searchParams.get("pair") || "BTC/JPY";
  const timeframe = req.nextUrl.searchParams.get("timeframe") || "1h";
  const limit = Number(req.nextUrl.searchParams.get("limit") || "100");

  try {
    const exchange = getExchange();
    await exchange.connect();
    const bars = await exchange.getOHLCV(pair, timeframe, limit);
    return NextResponse.json(bars);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
