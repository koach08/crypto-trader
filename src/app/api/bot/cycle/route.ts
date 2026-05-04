import { NextResponse } from "next/server";
import { runSingleCycle } from "@/lib/trading/engine";

export async function POST() {
  try {
    await runSingleCycle();
    return NextResponse.json({ ok: true, message: "Cycle completed" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
