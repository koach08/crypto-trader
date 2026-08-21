import { describe, it, expect } from "vitest";
import { slippageJPY, summarizeExecutionCosts, type ExecutionCost } from "./execution-cost";

describe("slippageJPY", () => {
  it("買いは中値より高く買った分がコスト", () => {
    expect(slippageJPY("buy", 202, 201, 100)).toBeCloseTo(100, 8);
  });
  it("売りは中値より安く売った分がコスト", () => {
    expect(slippageJPY("sell", 200, 201, 100)).toBeCloseTo(100, 8);
  });
  it("有利に約定したらマイナス (コストではなく取り分)", () => {
    expect(slippageJPY("buy", 200, 201, 100)).toBeCloseTo(-100, 8);
  });
  it("値が欠けていれば 0 (推定値を混ぜない)", () => {
    expect(slippageJPY("buy", 0, 201, 100)).toBe(0);
    expect(slippageJPY("buy", 202, 0, 100)).toBe(0);
  });
});

describe("summarizeExecutionCosts", () => {
  const mk = (pair: string, slip: number, notional: number, maker: boolean): ExecutionCost => ({
    at: "2026-08-21T00:00:00.000Z", pair, side: "buy", amountBase: 1,
    fillPrice: 1, refMid: 1, notionalJPY: notional, slippageJPY: slip, viaMaker: maker,
  });

  it("ペアごとにコストと約定率をまとめる", () => {
    const s = summarizeExecutionCosts([
      mk("XRP/JPY", 30, 10_000, false),
      mk("XRP/JPY", 0, 10_000, true),
      mk("BTC/JPY", 5, 12_000, false),
    ]);
    expect(s.fills).toBe(3);
    expect(s.notionalJPY).toBe(32_000);
    expect(s.slippageJPY).toBe(35);
    expect(s.makerRate).toBeCloseTo(100 / 3, 6);
    const xrp = s.rows.find((r) => r.pair === "XRP/JPY")!;
    expect(xrp.costPercent).toBeCloseTo(30 / 20_000 * 100, 8);
    // コストの大きい順
    expect(s.rows[0].pair).toBe("XRP/JPY");
  });

  it("空なら 0 を返して割り算を壊さない", () => {
    const s = summarizeExecutionCosts([]);
    expect(s.fills).toBe(0);
    expect(s.costPercent).toBe(0);
    expect(s.since).toBeNull();
  });
});
