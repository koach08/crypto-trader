import { describe, it, expect } from "vitest";
import { SELL_RETRY_FACTORS, MAKER_SELL_SAFETY } from "./bitflyer";

/**
 * 売却数量を最初から削らないことを縛る。
 * 1 回目から 0.5% 削っていたせいで、売るたびに端数が口座に残り、
 * 最小注文を下回るダストになって「売却可能数量未満」を出し続けていた。
 */
describe("売却数量のリトライ係数", () => {
  it("1 回目は全量 (削らない)", () => {
    expect(SELL_RETRY_FACTORS[0]).toBe(1);
  });

  it("削る順は緩やかな順で、最後でも 5% まで", () => {
    for (let i = 1; i < SELL_RETRY_FACTORS.length; i++) {
      expect(SELL_RETRY_FACTORS[i]).toBeLessThan(SELL_RETRY_FACTORS[i - 1]);
    }
    expect(SELL_RETRY_FACTORS[SELL_RETRY_FACTORS.length - 1]).toBeGreaterThanOrEqual(0.95);
  });

  it("2 番目でも 0.1% 未満しか削らない (いきなり大きく削らない)", () => {
    expect(1 - SELL_RETRY_FACTORS[1]).toBeLessThan(0.001);
  });

  it("メイカー指値の安全マージンは 0.01% 以内", () => {
    expect(1 - MAKER_SELL_SAFETY).toBeLessThanOrEqual(0.0001);
  });
});
