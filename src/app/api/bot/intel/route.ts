import { NextRequest, NextResponse } from "next/server";
import { getAggregatedIntel } from "@/lib/intel/aggregator";

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const intel = await getAggregatedIntel({ force });
  return NextResponse.json(intel);
}
