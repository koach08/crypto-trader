import { NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";

export async function GET() {
  try {
    const exchange = getExchange();
    await exchange.connect();
    const balances = await exchange.getBalance();
    return NextResponse.json(balances);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
