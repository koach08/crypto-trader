import { NextRequest, NextResponse } from "next/server";
import { getTrades, ensureReady } from "@/lib/trading/engine";

/**
 * 既定で「直近 200 件」かつ「aiDecision を除いた軽量版」を返す。
 *
 * 【なぜ】ダッシュボードは 30 秒ごとにこれを取りに来るが、1 レコードに
 * AI 各エンジンの判断全文 (aiDecision.engineResults) が丸ごと入っており、
 * 200 件で 500KB 超になっていた。画面側は timestamp / pair / side / pnl しか
 * 使っておらず (aiDecision の参照箇所はゼロ)、通信量がまるごと無駄だった。
 *
 * クエリ:
 *   limit=0  … 全件 (履歴ページ用)
 *   full=1   … aiDecision を含めた完全版 (デバッグ用)
 */
export async function GET(req: NextRequest) {
  await ensureReady();
  const params = new URL(req.url).searchParams;
  const limitParam = params.get("limit");
  const limit = limitParam === null ? 200 : Number(limitParam);
  const full = params.get("full") === "1";

  const all = getTrades();
  const sliced = Number.isFinite(limit) && limit > 0 ? all.slice(-limit) : all;
  const trades = full
    ? sliced
    : sliced.map(({ aiDecision: _aiDecision, ...rest }) => rest);

  return NextResponse.json({ trades, total: all.length });
}
