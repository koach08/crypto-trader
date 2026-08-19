import { NextResponse } from "next/server";
import { getCoreHoldingReport, updateCoreConfig, previewCoreBuy } from "@/lib/trading/engine";

/**
 * コア保有 (売らない長期枠) の状態取得と設定変更。
 *
 * GET  … 現在の積立状況 + 「次に積むならこれ」の事前確認
 * POST … 有効/無効、目標比率、比重、分割回数、間隔の変更
 */
export async function GET() {
  const report = await getCoreHoldingReport();
  const preview = await previewCoreBuy().catch(() => null);
  return NextResponse.json({ report, preview });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const cfg = await updateCoreConfig({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      targetPct: typeof body.targetPct === "number" ? body.targetPct : undefined,
      weights: body.weights && typeof body.weights === "object" ? body.weights : undefined,
      tranches: typeof body.tranches === "number" ? body.tranches : undefined,
      intervalHours: typeof body.intervalHours === "number" ? body.intervalHours : undefined,
      minTrancheJPY: typeof body.minTrancheJPY === "number" ? body.minTrancheJPY : undefined,
    });
    return NextResponse.json({ ok: true, config: cfg });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
