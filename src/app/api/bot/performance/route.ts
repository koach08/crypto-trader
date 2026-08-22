import { NextResponse } from "next/server";
import { getPerformanceReport } from "@/lib/trading/engine";

/**
 * 成績。主指標は cryptoReturn (買った暗号資産に対する損益)。
 * 総資産 (navJPY) は入金でも増えるので、成績としては読まないこと。
 */
export async function GET() {
  return NextResponse.json(await getPerformanceReport());
}
