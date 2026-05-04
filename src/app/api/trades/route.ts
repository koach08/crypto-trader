import { NextResponse } from "next/server";
import { getTrades, ensureReady } from "@/lib/trading/engine";

export async function GET() {
  await ensureReady();
  return NextResponse.json({ trades: getTrades() });
}
