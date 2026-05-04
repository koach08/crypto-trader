import { NextRequest, NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";

export async function GET(req: NextRequest) {
  const pair = req.nextUrl.searchParams.get("pair") || "BTC/JPY";

  try {
    const exchange = getExchange();
    await exchange.connect();
    const ticker = await exchange.getTicker(pair);
    return NextResponse.json(ticker);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
