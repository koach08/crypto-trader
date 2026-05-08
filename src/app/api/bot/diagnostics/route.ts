import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";
import type { AIDecision } from "@/lib/types";

export async function GET() {
  const decisions = await loadData<AIDecision[]>("decisions", []);
  const recent = decisions.slice(-100);

  const total = recent.length;
  const byAction = {
    BUY: recent.filter((d) => d.action === "BUY").length,
    SELL: recent.filter((d) => d.action === "SELL").length,
    HOLD: recent.filter((d) => d.action === "HOLD").length,
  };

  // 規律フィルタによる HOLD 化を reason 文字列から検出
  const rejectedByMTF = recent.filter(
    (d) => d.reason?.includes("[MTF]") && d.reason?.includes("不一致")
  ).length;
  const rejectedByEV = recent.filter(
    (d) => d.reason?.includes("[EV]") && d.reason?.includes("スキップ")
  ).length;
  const calibrationApplied = recent.filter((d) => d.reason?.includes("[補正]")).length;

  // ペア別集計
  const byPair: Record<string, { total: number; buy: number; sell: number; hold: number }> = {};
  for (const d of recent) {
    if (!byPair[d.pair]) byPair[d.pair] = { total: 0, buy: 0, sell: 0, hold: 0 };
    byPair[d.pair].total++;
    if (d.action === "BUY") byPair[d.pair].buy++;
    else if (d.action === "SELL") byPair[d.pair].sell++;
    else byPair[d.pair].hold++;
  }

  return NextResponse.json({
    window: total,
    byAction,
    filters: {
      rejectedByMTF,
      rejectedByEV,
      calibrationApplied,
    },
    byPair,
    sample: recent.slice(-15).reverse().map((d) => ({
      timestamp: d.timestamp,
      pair: d.pair,
      action: d.action,
      confidence: d.confidence,
      reason: d.reason?.slice(0, 200),
    })),
  });
}
