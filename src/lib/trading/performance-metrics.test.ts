import { describe, it, expect } from "vitest";
import { computeDrawdown, computeTradeQuality, INSTITUTIONAL_BENCHMARK } from "./performance-metrics";

const pt = (at: string, equityJPY: number) => ({ at, equityJPY });

describe("computeDrawdown", () => {
  it("ピークからの最大下落を出す", () => {
    const r = computeDrawdown([
      pt("2026-05-14T00:00:00.000Z", 76_903),
      pt("2026-05-30T00:00:00.000Z", 78_428),
      pt("2026-08-17T00:00:00.000Z", 59_800),
      pt("2026-08-26T00:00:00.000Z", 70_000),
    ]);
    expect(r.maxDrawdownPercent).toBeCloseTo((59_800 - 78_428) / 78_428 * 100, 4);
    expect(r.peakAt).toBe("2026-05-30T00:00:00.000Z");
    expect(r.troughAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("いま水面下なら現在の下落率と日数を出す", () => {
    const r = computeDrawdown([
      pt("2026-08-01T00:00:00.000Z", 100_000),
      pt("2026-08-11T00:00:00.000Z", 90_000),
    ]);
    expect(r.currentDrawdownPercent).toBeCloseTo(-10, 6);
    expect(r.daysUnderwater).toBeCloseTo(10, 1);
  });

  it("ピーク更新中なら現在の下落は 0", () => {
    const r = computeDrawdown([pt("2026-08-01T00:00:00.000Z", 100), pt("2026-08-02T00:00:00.000Z", 120)]);
    expect(r.currentDrawdownPercent).toBe(0);
    expect(r.daysUnderwater).toBe(0);
  });

  it("空なら 0 (割り算を壊さない)", () => {
    expect(computeDrawdown([]).maxDrawdownPercent).toBe(0);
  });
});

describe("computeTradeQuality", () => {
  it("実測値からエッジの有無を判定する", () => {
    // 2026-08 の戦術枠: 平均利益 ¥283 (50件) / 平均損失 ¥359 (81件)
    const r = computeTradeQuality({
      wins: 50, losses: 81, grossProfitJPY: 283 * 50, grossLossJPY: 359 * 81,
    });
    expect(r.winRatePercent).toBeCloseTo(38.2, 1);
    expect(r.payoffRatio).toBeCloseTo(0.788, 2);
    expect(r.requiredPayoffRatio).toBeCloseTo(1.62, 2);
    expect(r.hasEdge).toBe(false);
    expect(r.expectancyJPY).toBeLessThan(0);
    expect(r.profitFactor).toBeLessThan(1);
  });

  it("損益比が必要水準を超えていればエッジありと判定する", () => {
    const r = computeTradeQuality({
      wins: 30, losses: 70, grossProfitJPY: 30 * 1_000, grossLossJPY: 70 * 300,
    });
    expect(r.requiredPayoffRatio).toBeCloseTo(2.333, 2);
    expect(r.payoffRatio).toBeCloseTo(3.333, 2);
    expect(r.hasEdge).toBe(true);
    // エッジはあるが、機関投資家の目安 1.8 には届かない (1.43)。
    // 「勝てる」と「合格水準」は別物なので、両方を見る必要がある。
    expect(r.profitFactor).toBeGreaterThan(1);
    expect(r.profitFactor).toBeLessThan(INSTITUTIONAL_BENCHMARK.profitFactor);
  });

  it("負けが無ければ profitFactor は無限大にする (0 割りしない)", () => {
    const r = computeTradeQuality({ wins: 3, losses: 0, grossProfitJPY: 900, grossLossJPY: 0 });
    expect(r.profitFactor).toBe(Infinity);
  });

  it("取引が無ければ 0", () => {
    const r = computeTradeQuality({ wins: 0, losses: 0, grossProfitJPY: 0, grossLossJPY: 0 });
    expect(r.trades).toBe(0);
    expect(r.expectancyJPY).toBe(0);
    expect(r.hasEdge).toBe(false);
  });
});
