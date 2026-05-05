import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";

interface PnLSnapshot {
  timestamp: string;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  trades: number;
}

export async function GET() {
  try {
    const history = await loadData<PnLSnapshot[]>("pnl-history", []);
    return NextResponse.json(history);
  } catch (e) {
    return NextResponse.json([], { status: 500 });
  }
}
