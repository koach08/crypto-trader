import { NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";

export async function POST() {
  try {
    const exchange = getExchange();
    await exchange.connect();

    // ⚠️ SOL/JPY は BitFlyer に存在しない (BadSymbol) ため入れない。
    const pairs = ["BTC/JPY", "ETH/JPY", "XRP/JPY", "XLM/JPY", "MONA/JPY"];
    let canceled = 0;

    for (const pair of pairs) {
      const opens = await exchange.getOpenOrders(pair).catch(() => []);
      for (const o of opens) {
        if (o.side === "buy" && o.id) {
          const ok = await exchange.cancelOrder(o.id, pair).catch(() => false);
          if (ok) canceled++;
        }
      }
    }

    return NextResponse.json({ ok: true, canceled, message: `${canceled} orders canceled` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
