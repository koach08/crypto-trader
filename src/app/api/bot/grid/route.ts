import { NextResponse } from "next/server";
import { getCurrentGridPlan, getGridState } from "@/lib/trading/grid-trader";
import { loadData } from "@/lib/data";

export async function GET() {
  const plan = await getCurrentGridPlan();
  // 各 pair の grid state
  const allStates = await loadData<Record<string, unknown>>("grid-trader-state", {});
  return NextResponse.json({
    enabled: process.env.GRID_ENABLED === "1",
    capitalPercent: Number(process.env.GRID_CAPITAL_PERCENT ?? "15"),
    plan,
    states: allStates,
  });
}
