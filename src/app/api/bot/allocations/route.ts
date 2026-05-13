import { NextResponse } from "next/server";
import { getEngineAllocations } from "@/lib/trading/engine";

export async function GET() {
  const allocations = await getEngineAllocations();
  return NextResponse.json({ allocations });
}
