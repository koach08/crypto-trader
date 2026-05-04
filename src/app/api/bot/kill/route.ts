import { NextResponse } from "next/server";
import { killBot } from "@/lib/trading/engine";

export async function POST() {
  await killBot();
  return NextResponse.json({ ok: true, message: "Emergency stop activated" });
}
