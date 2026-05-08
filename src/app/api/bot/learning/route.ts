import { NextResponse } from "next/server";
import { getAudits } from "@/lib/quant/audit-log";
import { BASELINE_SIGNAL_WEIGHTS, getActiveSignalWeights } from "@/lib/quant/signals";
import { computeLearnedWeights } from "@/lib/quant/signal-learning";

export async function GET() {
  const audits = await getAudits(500);
  const summary = computeLearnedWeights(audits, BASELINE_SIGNAL_WEIGHTS);
  return NextResponse.json({
    active: getActiveSignalWeights(),
    summary,
  });
}
