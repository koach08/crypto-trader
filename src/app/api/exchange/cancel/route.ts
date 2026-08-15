import { NextRequest, NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";

export async function POST(req: NextRequest) {
  try {
    const { orderId, pair } = await req.json();
    if (!orderId || !pair) {
      return NextResponse.json({ error: "orderId and pair required" }, { status: 400 });
    }

    const exchange = getExchange();
    await exchange.connect();

    const ok = await exchange.cancelOrder(orderId, pair);
    return NextResponse.json({ ok, orderId, pair });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
