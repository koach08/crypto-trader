import { NextRequest, NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";
import { loadData, saveData } from "@/lib/data";

interface PositionRecord {
  pair: string;
  amount: number;
  entryPrice: number;
  entryTimestamp: string;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  [k: string]: unknown;
}

/**
 * 下限の評価額。ただし本当の判定は「取引所の最小注文に届くか」。
 *
 * ¥500 固定だと、¥500 を超えるのに売れない玉が残る。実際 BTC 0.00015803
 * (¥1,917) が居座っていた。BTC の最小注文は ¥13,335 なので永久に売れないが、
 * ¥500 の閾値は通ってしまう。売れない玉はポジションとして持っていても
 * 判定を汚すだけなので、最小注文に届かないものを dust とする。
 */
const DUST_THRESHOLD_JPY = 500;

/**
 * POST /api/bot/cleanup-dust
 *
 * livePositions から評価額が ¥500 未満の dust ポジションを除去する。
 * 実残高 (BitFlyer 側) には触らない (どっちみち売却不能サイズ)。
 *
 * dryRun=true (default) で削除対象を列挙、dryRun=false で実削除。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun !== false;

  try {
    const exchange = getExchange();
    await exchange.connect();

    const positions = await loadData<PositionRecord[]>("live-positions", []);
    const dustList: { pair: string; amount: number; valueJPY: number; reason: string }[] = [];
    const kept: PositionRecord[] = [];

    for (const p of positions) {
      let valueJPY = 0;
      try {
        const t = await exchange.getTicker(p.pair);
        valueJPY = p.amount * t.price;
      } catch (e) {
        // ticker 取得失敗 = ペアが廃止された可能性。amount * entryPrice で推定
        valueJPY = p.amount * (p.entryPrice ?? 0);
      }

      // 売れるかどうかが本当の基準。最小注文に届かない玉は持っていても動かせない。
      let minOrderJPY = 0;
      try {
        const t = await exchange.getTicker(p.pair);
        minOrderJPY = exchange.getMinOrderJPY?.(p.pair, t.price) ?? 0;
      } catch { /* ticker が取れないなら固定閾値だけで判定する */ }

      const threshold = Math.max(DUST_THRESHOLD_JPY, minOrderJPY);
      const noEntryPrice = !(p.entryPrice > 0);
      if (valueJPY < threshold || noEntryPrice) {
        dustList.push({
          pair: p.pair,
          amount: p.amount,
          valueJPY: Math.round(valueJPY),
          reason: noEntryPrice
            ? `建値が無い (¥${Math.round(valueJPY)} / 最小注文 ¥${Math.round(minOrderJPY)})`
            : `評価額 ¥${Math.round(valueJPY)} < 売れる下限 ¥${Math.round(threshold)}` +
              (minOrderJPY > DUST_THRESHOLD_JPY ? ` (最小注文)` : ` (dust 閾値)`),
        });
      } else {
        kept.push(p);
      }
    }

    if (!dryRun && dustList.length > 0) {
      await saveData("live-positions", kept);
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      threshold: DUST_THRESHOLD_JPY,
      totalPositions: positions.length,
      dustCount: dustList.length,
      keptCount: kept.length,
      dust: dustList,
      message: dryRun
        ? `${dustList.length} 件の dust 検出 (dryRun=true で未削除)。実行するには {"dryRun":false} で再 POST`
        : `${dustList.length} 件の dust を削除しました (残 ${kept.length} 件)`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
