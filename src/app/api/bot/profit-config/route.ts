import { NextRequest, NextResponse } from "next/server";
import { loadData, saveData } from "@/lib/data";
import type { ProfitConfig } from "@/lib/types";
import { DEFAULT_PROFIT_CONFIG } from "@/lib/types";

export async function GET() {
  const config = await loadData<ProfitConfig>("profit-config", DEFAULT_PROFIT_CONFIG);
  return NextResponse.json(config);
}

export async function POST(req: NextRequest) {
  const config = await req.json() as Partial<ProfitConfig>;
  const current = await loadData<ProfitConfig>("profit-config", DEFAULT_PROFIT_CONFIG);
  const merged: ProfitConfig = {
    dailyTargetPercent: Number(config.dailyTargetPercent ?? current.dailyTargetPercent),
    tpPercent: Number(config.tpPercent ?? current.tpPercent),
    slPercent: Number(config.slPercent ?? current.slPercent),
    minConfidence: Number(config.minConfidence ?? current.minConfidence),
  };
  await saveData("profit-config", merged);
  return NextResponse.json({ ok: true, config: merged });
}
