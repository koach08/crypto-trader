import { NextResponse } from "next/server";
import { getAudits, getPerformanceSummary } from "@/lib/quant/audit-log";

export async function GET() {
  try {
    const [audits, summary] = await Promise.all([
      getAudits(50),
      getPerformanceSummary(),
    ]);
    return NextResponse.json({ audits, summary });
  } catch {
    return NextResponse.json({ audits: [], summary: null });
  }
}
