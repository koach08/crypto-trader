import { NextResponse } from "next/server";
import { getExecutionCostReport } from "@/lib/trading/engine";

/** 執行コスト (中値に対する不利分) の集計。判断の質とは別に、執行で払っている額を見る。 */
export async function GET() {
  const report = await getExecutionCostReport();
  return NextResponse.json(report);
}
