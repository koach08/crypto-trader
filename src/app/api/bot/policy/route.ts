import { NextResponse } from "next/server";
import {
  getCapitalPolicy,
  getPolicyLog,
  TIER_LIMITS,
} from "@/lib/trading/capital-policy";

export async function GET() {
  const policy = await getCapitalPolicy();
  const log = await getPolicyLog(20);
  const limits = TIER_LIMITS[policy.tier];

  return NextResponse.json({
    current: policy,
    limits,
    allTiers: TIER_LIMITS,
    history: log,
  });
}
