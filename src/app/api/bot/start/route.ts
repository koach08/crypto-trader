import { NextRequest, NextResponse } from "next/server";
import { startBot } from "@/lib/trading/engine";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    await startBot(body);
    return NextResponse.json({ ok: true, message: "Bot started" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
