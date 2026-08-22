import { describe, it, expect } from "vitest";
import { riskBudgetedSize } from "./risk-sizing";

const base = {
  navJPY: 123_425, riskFraction: 0.01, stopLossPercent: 8,
  availableJPY: 500_000, maxJPY: 500_000, minOrderJPY: 3_000,
};

describe("riskBudgetedSize", () => {
  it("損切りを広げてもリスク量は変わらない", () => {
    const wide = riskBudgetedSize({ ...base, stopLossPercent: 8 });
    const tight = riskBudgetedSize({ ...base, stopLossPercent: 2 });
    // 建玉サイズは 4 倍違うが、失う額は同じ
    expect(tight.sizeJPY).toBeCloseTo(wide.sizeJPY * 4, -2);
    expect(tight.riskJPY).toBeCloseTo(wide.riskJPY, 0);
    expect(wide.riskJPY).toBeCloseTo(1_234, 0);
  });

  it("総資産が増えればサイズも増える", () => {
    const small = riskBudgetedSize({ ...base, navJPY: 60_000 });
    const big = riskBudgetedSize({ ...base, navJPY: 240_000 });
    expect(big.sizeJPY).toBeGreaterThan(small.sizeJPY * 3.9);
  });

  it("現金が足りなければ縮める", () => {
    const r = riskBudgetedSize({ ...base, availableJPY: 5_000 });
    expect(r.sizeJPY).toBe(5_000);
  });

  it("最小注文に届かないなら見送る (無理に上げてリスク割合を超えない)", () => {
    const r = riskBudgetedSize({ ...base, navJPY: 20_000, minOrderJPY: 12_000 });
    expect(r.sizeJPY).toBe(0);
    expect(r.reason).toContain("最小注文");
  });

  it("入力が壊れていれば 0 (推定で発注しない)", () => {
    expect(riskBudgetedSize({ ...base, navJPY: 0 }).sizeJPY).toBe(0);
    expect(riskBudgetedSize({ ...base, stopLossPercent: 0 }).sizeJPY).toBe(0);
  });
});
