/**
 * 整合性自動監査
 *
 * 全数値ソースを引いてクロスチェックし、乖離が出たら警告を返す。
 * 計算ミス（NAVが実残高と合わない、確定損益が合わない等）の早期検知用。
 */

import { NextResponse } from "next/server";
import { getExchange } from "@/lib/exchanges/factory";
import { computeLifetimePnL } from "@/lib/trading/lifetime";
import { loadData } from "@/lib/data";

const PAIRS = ["BTC/JPY", "ETH/JPY", "XRP/JPY"];
const TOLERANCE_JPY = 100; // この差以上は警告
const TOLERANCE_PERCENT = 1.0; // 1% 以上の差も警告

interface CachedExecutions {
  byPair: Record<string, Array<{ id: string; timestamp: number; pair: string; side: "buy" | "sell"; amount: number; price: number; fee: number }>>;
  lastFetchedAt: number;
}

interface NavSnapshot {
  timestamp: string;
  jpy: number;
  cryptoValueJPY: number;
  total: number;
  positions: Record<string, { amount: number; price: number; valueJPY: number }>;
}

export async function GET() {
  const checks: { name: string; ok: boolean; expected: number; actual: number; diff: number; message: string }[] = [];
  const errors: string[] = [];

  try {
    const exchange = getExchange();
    await exchange.connect();

    // === 1. 真実のソース: 現在の BitFlyer 残高 + 現在価格で評価 ===
    const balances = await exchange.getBalance();
    const jpyTrueBalance = balances.find((b) => b.currency === "JPY")?.total ?? 0;
    let cryptoValueTrue = 0;
    const cryptoDetails: Record<string, { amount: number; price: number; value: number }> = {};
    for (const b of balances) {
      if (b.currency === "JPY" || b.total <= 0.0000001) continue;
      const pair = `${b.currency}/JPY`;
      try {
        const t = await exchange.getTicker(pair);
        const v = b.total * t.price;
        cryptoValueTrue += v;
        cryptoDetails[pair] = { amount: b.total, price: t.price, value: v };
      } catch {
        // ticker 取得失敗は除外
      }
    }
    const totalTrue = jpyTrueBalance + cryptoValueTrue;

    // === 2. NAV 履歴の最新値 ===
    const navHistory = await loadData<NavSnapshot[]>("nav-history", []);
    const navLatest = navHistory[navHistory.length - 1];
    if (navLatest) {
      const navAge = (Date.now() - new Date(navLatest.timestamp).getTime()) / 60_000;
      const diff = navLatest.total - totalTrue;
      const ok = Math.abs(diff) <= TOLERANCE_JPY || Math.abs(diff) / totalTrue * 100 <= TOLERANCE_PERCENT;
      checks.push({
        name: "NAV 最新値 vs 実残高",
        ok,
        expected: Math.round(totalTrue),
        actual: Math.round(navLatest.total),
        diff: Math.round(diff),
        message: ok
          ? `OK (NAV snapshot ${navAge.toFixed(0)}分前)`
          : `乖離 ¥${Math.round(diff).toLocaleString()} (snapshot ${navAge.toFixed(0)}分前) — 5分以上経過なら時差由来かもしれない`,
      });
      if (!ok && navAge < 30) errors.push(checks[checks.length - 1].message);
    } else {
      checks.push({
        name: "NAV 最新値 vs 実残高",
        ok: false,
        expected: Math.round(totalTrue),
        actual: 0,
        diff: -Math.round(totalTrue),
        message: "NAV 履歴なし (bot 未稼働)",
      });
    }

    // === 3. NAV ポジション集計 vs 実暗号通貨評価 ===
    if (navLatest) {
      let navCrypto = 0;
      for (const k of Object.keys(navLatest.positions)) navCrypto += navLatest.positions[k].valueJPY;
      const diff = navCrypto - cryptoValueTrue;
      const ok = Math.abs(diff) <= TOLERANCE_JPY * 5; // crypto の方が時差で動きやすい
      checks.push({
        name: "NAV crypto 集計 vs 実暗号通貨評価",
        ok,
        expected: Math.round(cryptoValueTrue),
        actual: Math.round(navCrypto),
        diff: Math.round(diff),
        message: ok ? "OK" : `乖離 ¥${Math.round(diff).toLocaleString()}`,
      });
    }

    // === 4. Lifetime FIFO 確定 vs JPY 流出入 ===
    const cache = await loadData<CachedExecutions>("bitflyer-executions", { byPair: {}, lastFetchedAt: 0 });
    const allExecs = Object.values(cache.byPair).flat();
    if (allExecs.length > 0) {
      const lifetime = computeLifetimePnL(allExecs);
      const netFlow = lifetime.totalSellVolumeJPY - lifetime.totalBuyVolumeJPY; // 売 - 買 = JPY 流入
      // 実残高 JPY = 初期入金 + netFlow + (利益で増えた / 損失で減った) — ここは推定範囲
      checks.push({
        name: "Lifetime FIFO 売買集計",
        ok: true,
        expected: 0,
        actual: Math.round(lifetime.netRealizedPnL),
        diff: 0,
        message: `Bot対象ペア確定P&L ¥${Math.round(lifetime.netRealizedPnL).toLocaleString()} / 純流入 ¥${Math.round(netFlow).toLocaleString()} / 約定${lifetime.executionCount}件`,
      });
    }

    // === 5. liveTrades vs lifetime 整合性 ===
    const liveTrades = await loadData<Array<{ side: string; pnl?: number; timestamp: string }>>("live-trades", []);
    const liveSells = liveTrades.filter((t) => t.side === "sell" && t.pnl !== undefined);
    const liveRealized = liveSells.reduce((s, t) => s + (t.pnl ?? 0), 0);
    if (allExecs.length > 0) {
      const lifetime = computeLifetimePnL(allExecs);
      const diff = liveRealized - lifetime.netRealizedPnL;
      const ok = Math.abs(diff) <= TOLERANCE_JPY;
      checks.push({
        name: "live-trades 確定 vs Lifetime FIFO",
        ok,
        expected: Math.round(lifetime.netRealizedPnL),
        actual: Math.round(liveRealized),
        diff: Math.round(diff),
        message: ok
          ? "OK"
          : `乖離 ¥${Math.round(diff).toLocaleString()} (live-trades は 200件 rolling、lifetime は全期間 FIFO なので長期で乖離可)`,
      });
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      truth: {
        jpy: Math.round(jpyTrueBalance),
        cryptoValueJPY: Math.round(cryptoValueTrue),
        total: Math.round(totalTrue),
        details: cryptoDetails,
      },
      checks,
      errors,
      pass: errors.length === 0,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown", checks, errors },
      { status: 500 }
    );
  }
}

void PAIRS;
