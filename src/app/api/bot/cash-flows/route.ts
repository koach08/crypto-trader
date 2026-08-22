import { NextResponse } from "next/server";
import { loadData, saveData } from "@/lib/data";
import type { CashFlow } from "@/lib/trading/cash-flow";

/** 入出金の台帳。GET で一覧、POST で1件追加 (入金は +、出金は -)。 */
export async function GET() {
  return NextResponse.json({ flows: await loadData<CashFlow[]>("cash-flows", []) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const amountJPY = Number(body.amountJPY);
    if (!Number.isFinite(amountJPY) || amountJPY === 0) {
      return NextResponse.json({ ok: false, error: "amountJPY が不正" }, { status: 400 });
    }
    const flows = await loadData<CashFlow[]>("cash-flows", []);
    const entry: CashFlow = {
      at: typeof body.at === "string" ? body.at : new Date().toISOString(),
      amountJPY,
      note: typeof body.note === "string" ? body.note : undefined,
      source: "manual",
    };
    flows.push(entry);
    flows.sort((a, b) => a.at.localeCompare(b.at));
    await saveData("cash-flows", flows);
    return NextResponse.json({ ok: true, entry, flows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
