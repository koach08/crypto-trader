import { describe, it, expect } from "vitest";
import { buildFundingReport, buildCryptoReturn, detectCashFlow, type CashFlow } from "./cash-flow";

const flow = (amountJPY: number): CashFlow => ({
  at: "2026-08-22T03:48:00.000Z", amountJPY, source: "auto",
});

describe("buildFundingReport", () => {
  it("入金を成績に混ぜない", () => {
    // 起点 ¥76,903 に ¥50,000 入れて、いま ¥122,085。
    // 総資産は +58.8% でも、実際は投入額を下回っている。
    const r = buildFundingReport({
      baselineJPY: 76_903, baselineAt: "2026-05-14T07:32:23.334Z",
      currentNavJPY: 122_085, flows: [flow(50_000)],
    });
    expect(r.investedJPY).toBe(126_903);
    expect(r.profitJPY).toBe(-4_818);
    expect(r.profitPercent).toBeCloseTo(-3.797, 2);
  });

  it("出金は投入額から引く", () => {
    const r = buildFundingReport({
      baselineJPY: 100_000, baselineAt: null, currentNavJPY: 60_000,
      flows: [flow(-50_000)],
    });
    expect(r.withdrawalsJPY).toBe(50_000);
    expect(r.investedJPY).toBe(50_000);
    expect(r.profitJPY).toBe(10_000);
  });

  it("入出金が無ければ素直な損益になる", () => {
    const r = buildFundingReport({
      baselineJPY: 100_000, baselineAt: null, currentNavJPY: 110_000, flows: [],
    });
    expect(r.investedJPY).toBe(100_000);
    expect(r.profitPercent).toBeCloseTo(10, 8);
  });
});

describe("detectCashFlow", () => {
  it("売買で説明できない大きな増加を入金として拾う", () => {
    // 本番の実データ: JPY 4,973 → 52,501、その間の売買は無し
    expect(detectCashFlow({ jpyBefore: 4_973, jpyAfter: 52_501, tradeNetJPY: 0 })).toBeCloseTo(47_528, 6);
  });

  it("売買で説明がつく分は拾わない", () => {
    expect(detectCashFlow({ jpyBefore: 10_000, jpyAfter: 55_000, tradeNetJPY: 45_000 })).toBeNull();
  });

  it("しきい値未満は無視する (誤検出は成績を良く見せるので危ない)", () => {
    expect(detectCashFlow({ jpyBefore: 10_000, jpyAfter: 25_000, tradeNetJPY: 0 })).toBeNull();
  });

  it("出金も拾う", () => {
    expect(detectCashFlow({ jpyBefore: 80_000, jpyAfter: 20_000, tradeNetJPY: 0 })).toBeCloseTo(-60_000, 6);
  });
});

describe("buildCryptoReturn", () => {
  it("買った暗号資産に対する損益を出す (入金の影響を受けない)", () => {
    // 2026-08-22 の実データ
    const r = buildCryptoReturn({
      buyVolumeJPY: 1_392_447, sellVolumeJPY: 1_348_572,
      holdingsValueJPY: 69_584, realizedJPY: -5_256,
    });
    expect(r.profitJPY).toBe(25_709);
    expect(r.profitPercent).toBeCloseTo(1.846, 2);
    expect(r.unrealizedJPY).toBe(30_965);
  });

  it("入金しても損益率は動かない", () => {
    const a = buildCryptoReturn({ buyVolumeJPY: 100_000, sellVolumeJPY: 0, holdingsValueJPY: 110_000, realizedJPY: 0 });
    // 現金を足しても購入代金も評価額も変わらないので同じ
    expect(a.profitPercent).toBeCloseTo(10, 8);
  });

  it("買っていなければ 0 で割らない", () => {
    const r = buildCryptoReturn({ buyVolumeJPY: 0, sellVolumeJPY: 0, holdingsValueJPY: 0, realizedJPY: 0 });
    expect(r.profitPercent).toBe(0);
  });
});
