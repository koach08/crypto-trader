import { NextResponse } from "next/server";
import { getAggregatedIntel } from "@/lib/intel/aggregator";

export async function GET() {
  const intel = await getAggregatedIntel();
  return NextResponse.json(intel);
}
