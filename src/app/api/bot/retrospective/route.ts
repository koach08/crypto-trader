import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";
import { getAudits } from "@/lib/quant/audit-log";
import { getActiveOverrides, getRetrospectiveLog, runStrategicRetrospective } from "@/lib/quant/retrospective";
import type { TradeRecord } from "@/lib/types";

/** 現在の戦略 overrides + 履歴 */
export async function GET() {
  const [active, log] = await Promise.all([getActiveOverrides(), getRetrospectiveLog(20)]);
  return NextResponse.json({ active, log });
}

/** 手動でリトロスペクティブ実行 (即時) */
export async function POST() {
  const trades = await loadData<TradeRecord[]>("live-trades", []);
  const audits = await getAudits(200);
  const tradeCount = trades.filter(t => t.side === "sell" && t.pnl !== undefined).length;
  const result = await runStrategicRetrospective(trades, audits, tradeCount);
  return NextResponse.json({ ok: !!result, overrides: result, tradeCount });
}
