import { NextResponse } from "next/server";
import { stopBot } from "@/lib/trading/engine";

export async function POST() {
  stopBot();
  return NextResponse.json({ ok: true, message: "Bot stopped" });
}
