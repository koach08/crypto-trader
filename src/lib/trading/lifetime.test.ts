import { describe, it, expect } from "vitest";
import { computeLifetimePnL } from "./lifetime";
import type { ExecutionRecord } from "../exchanges/types";

const makeExec = (
  side: "buy" | "sell",
  amount: number,
  price: number,
  fee = 0,
  ts = 0,
  pair = "BTC/JPY"
): ExecutionRecord => ({
  id: `${side}-${ts}`,
  timestamp: ts,
  pair,
  side,
  amount,
  price,
  fee,
});

describe("computeLifetimePnL FIFO", () => {
  it("単一買付: realized=0, 残在庫=量, avg=価格", () => {
    const r = computeLifetimePnL([makeExec("buy", 1, 1000)]);
    expect(r.totalRealizedPnL).toBe(0);
    expect(r.byPair[0].remainingInventory).toBe(1);
    expect(r.byPair[0].averageBuyPrice).toBe(1000);
  });

  it("買→全量売却 (利益): realized = (sell-buy) × amount - fees", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1),
      makeExec("sell", 1, 1100, 0, 2),
    ]);
    expect(r.totalRealizedPnL).toBe(100);
    expect(r.byPair[0].remainingInventory).toBe(0);
  });

  it("買→全量売却 (損失): 負の realized", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1),
      makeExec("sell", 1, 900, 0, 2),
    ]);
    expect(r.totalRealizedPnL).toBe(-100);
  });

  it("複数買→部分売却 (FIFO 順): 古い lot から消費", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1),
      makeExec("buy", 1, 1200, 0, 2),
      makeExec("sell", 1, 1100, 0, 3), // 1000 で買った1個を売る → +100
    ]);
    expect(r.totalRealizedPnL).toBe(100);
    expect(r.byPair[0].remainingInventory).toBe(1);
    expect(r.byPair[0].averageBuyPrice).toBe(1200);
  });

  it("売却 fee を pnl から差引く", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1),
      makeExec("sell", 1, 1100, 50, 2),
    ]);
    expect(r.totalRealizedPnL).toBe(50);
    expect(r.totalFees).toBe(50);
  });

  it("勝/負カウント正確", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1),
      makeExec("sell", 1, 1100, 0, 2),
      makeExec("buy", 1, 1100, 0, 3),
      makeExec("sell", 1, 1000, 0, 4),
    ]);
    expect(r.byPair[0].wins).toBe(1);
    expect(r.byPair[0].losses).toBe(1);
    expect(r.totalRealizedPnL).toBe(0);
  });

  it("ペア跨ぎで分離計算", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1, "BTC/JPY"),
      makeExec("buy", 100, 200, 0, 2, "XRP/JPY"),
      makeExec("sell", 1, 1200, 0, 3, "BTC/JPY"), // BTC +200
      makeExec("sell", 100, 180, 0, 4, "XRP/JPY"), // XRP -2000
    ]);
    expect(r.totalRealizedPnL).toBe(200 - 2000);
    expect(r.byPair).toHaveLength(2);
    const btc = r.byPair.find((p) => p.pair === "BTC/JPY");
    const xrp = r.byPair.find((p) => p.pair === "XRP/JPY");
    expect(btc?.realizedPnL).toBe(200);
    expect(xrp?.realizedPnL).toBe(-2000);
  });

  it("空配列: 全ゼロ", () => {
    const r = computeLifetimePnL([]);
    expect(r.totalRealizedPnL).toBe(0);
    expect(r.closedTrades).toBe(0);
    expect(r.byPair).toEqual([]);
  });

  it("売却が買付量を超える場合は超過分を無視 (空売り扱いしない)", () => {
    const r = computeLifetimePnL([
      makeExec("buy", 1, 1000, 0, 1),
      makeExec("sell", 2, 1100, 0, 2), // 1個分しかマッチしない
    ]);
    expect(r.totalRealizedPnL).toBe(100); // 1個分の利益のみ
    expect(r.byPair[0].remainingInventory).toBe(0);
  });
});
