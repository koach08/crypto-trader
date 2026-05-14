import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";
import { getAudits } from "@/lib/quant/audit-log";
import { analyzeLossPatterns } from "@/lib/quant/loss-analyzer";
import type { TradeRecord } from "@/lib/types";

export async function GET() {
  const trades = await loadData<TradeRecord[]>("live-trades", []);
  const audits = await getAudits(500);
  const analysis = analyzeLossPatterns(trades, audits);
  return NextResponse.json(analysis);
}
