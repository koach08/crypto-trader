import { NextResponse } from "next/server";
import { getPerformanceMetrics } from "@/lib/trading/engine";

/**
 * 運用成績の指標。ドローダウン / プロフィットファクター / 期待値 / 損益比。
 * 機関投資家の目安 (Sharpe>1.5 / DD<20% / PF>1.8) を benchmark に併記。
 */
export async function GET() {
  return NextResponse.json(await getPerformanceMetrics());
}
