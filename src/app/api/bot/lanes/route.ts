import { NextResponse } from "next/server";
import { getLanePnL } from "@/lib/trading/engine";

/** 枠別損益。コア枠 (買って持つ) と戦術枠 (短期売買) を分けて見る。 */
export async function GET() {
  return NextResponse.json(await getLanePnL());
}
