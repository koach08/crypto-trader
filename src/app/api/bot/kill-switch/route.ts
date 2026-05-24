import { NextRequest, NextResponse } from "next/server";
import { getKillSwitchState, resetKillSwitch } from "@/lib/trading/kill-switch";
import { getExchange } from "@/lib/exchanges/factory";
import type { Balance } from "@/lib/types";

export async function GET() {
  const state = await getKillSwitchState();
  return NextResponse.json(state);
}

/**
 * POST /api/bot/kill-switch
 * body: { action: "reset", reason?: string }
 * 現 NAV を取得し peak リセット.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body?.action !== "reset") {
    return NextResponse.json({ error: "action must be 'reset'" }, { status: 400 });
  }
  let nav = 0;
  try {
    const exchange = getExchange();
    await exchange.connect();
    const balance = await exchange.getBalance();
    nav = balance.find((b: Balance) => b.currency === "JPY")?.total ?? 0;
    for (const bal of balance) {
      if (bal.currency === "JPY" || bal.total <= 0.0000001) continue;
      try {
        const t = await exchange.getTicker(`${bal.currency}/JPY`);
        nav += bal.total * t.price;
      } catch {/* skip */}
    }
  } catch (e) {
    return NextResponse.json({ error: "NAV 取得失敗", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  if (nav <= 0) {
    return NextResponse.json({ error: "NAV が 0 です. 残高確認してください" }, { status: 400 });
  }
  const state = await resetKillSwitch(nav, String(body.reason ?? "manual"));
  return NextResponse.json({ ok: true, state });
}
