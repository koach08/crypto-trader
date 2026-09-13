import { NextResponse } from "next/server";
import { getDoNothingBenchmark } from "@/lib/trading/engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/benchmark
 * 「放置に勝っているか」。円のまま置いた場合と、入れた日に均等に買って
 * 持ちっぱなしにした場合を、いまのアプリの総資産と並べる。
 */
export async function GET() {
  try {
    return NextResponse.json(await getDoNothingBenchmark());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
