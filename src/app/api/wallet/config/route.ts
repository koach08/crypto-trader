import { NextRequest, NextResponse } from "next/server";
import { loadData, saveData } from "@/lib/data";
import type { WalletConfig } from "@/lib/types";

const DEFAULT_CONFIG: WalletConfig = {
  totalCapitalJPY: 0,
  allocationTargets: [
    { pair: "BTC/JPY", targetPercent: 50, maxPositionJPY: 100000 },
    { pair: "ETH/JPY", targetPercent: 30, maxPositionJPY: 60000 },
    { pair: "XRP/JPY", targetPercent: 20, maxPositionJPY: 40000 },
  ],
  reservePercent: 20,
};

export async function GET() {
  const config = await loadData<WalletConfig>("wallet-config", DEFAULT_CONFIG);
  return NextResponse.json(config);
}

export async function POST(req: NextRequest) {
  const config = await req.json() as WalletConfig;
  await saveData("wallet-config", config);
  return NextResponse.json({ ok: true });
}
