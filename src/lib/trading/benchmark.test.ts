import { describe, it, expect } from "vitest";
import { buildDoNothingBenchmark, nearestPrice } from "./benchmark";

const PAIRS = ["BTC/JPY", "ETH/JPY", "XRP/JPY"];

describe("buildDoNothingBenchmark", () => {
  it("2026-09-09 の手元スクリプトと同じ数字になる", () => {
    // scripts/vs-doing-nothing.py で出した実測値を固定する。
    // 5/14 に ¥76,903、8/22 に ¥50,000。各日の価格と現在価格も同じ。
    const table: Record<string, Record<string, number>> = {
      "2026-05-14": { "BTC/JPY": 12837107, "ETH/JPY": 361260, "XRP/JPY": 235 },
      "2026-08-22": { "BTC/JPY": 12253571, "ETH/JPY": 385371, "XRP/JPY": 233 },
    };
    const r = buildDoNothingBenchmark({
      flows: [
        { at: "2026-05-14T07:32:23.334Z", amountJPY: 76903 },
        { at: "2026-08-22T03:48:00.000Z", amountJPY: 50000 },
      ],
      pairs: PAIRS,
      priceAt: (pair, atMs) => table[new Date(atMs).toISOString().slice(0, 10)]?.[pair] ?? null,
      currentPrices: { "BTC/JPY": 12080000, "ETH/JPY": 382548, "XRP/JPY": 218.24 },
      currentNavJPY: 121497,
    });
    expect(r.cashOnlyJPY).toBe(126903);
    // スクリプトは ¥123,893。ここの価格は表示上の丸め (XRP ¥235 など) なので ±¥300 で見る
    expect(Math.abs(r.holdJPY! - 123893)).toBeLessThan(300);
    expect(Math.round(r.vsCashJPY)).toBe(-5406);
    expect(Math.abs(r.vsHoldJPY! - -2396)).toBeLessThan(300);
    expect(r.missing).toEqual([]);
  });

  it("出金は同じ日に同じ額を引き出したことにして数量を減らす", () => {
    const px = { "BTC/JPY": 100, "ETH/JPY": 10, "XRP/JPY": 1 };
    const r = buildDoNothingBenchmark({
      flows: [
        { at: "2026-01-01T00:00:00Z", amountJPY: 300 },
        { at: "2026-02-01T00:00:00Z", amountJPY: -150 },
      ],
      pairs: PAIRS,
      priceAt: (pair) => px[pair as keyof typeof px],
      currentPrices: px,
      currentNavJPY: 150,
    });
    expect(r.cashOnlyJPY).toBe(150);
    expect(r.holdJPY).toBeCloseTo(150, 6);
  });

  it("価格が取れない入金があれば均等買い持ちは null、円のままは出す", () => {
    const r = buildDoNothingBenchmark({
      flows: [{ at: "2026-01-01T00:00:00Z", amountJPY: 1000 }],
      pairs: PAIRS,
      priceAt: () => null,
      currentPrices: { "BTC/JPY": 1, "ETH/JPY": 1, "XRP/JPY": 1 },
      currentNavJPY: 900,
    });
    expect(r.cashOnlyJPY).toBe(1000);
    expect(r.holdJPY).toBeNull();
    expect(r.vsHoldJPY).toBeNull();
    expect(r.vsCashJPY).toBe(-100);
    expect(r.missing).toEqual(["2026-01-01T00:00:00Z"]);
  });
});

describe("nearestPrice", () => {
  const s = [
    { ts: Date.parse("2026-05-14T00:00:00Z"), price: 100 },
    { ts: Date.parse("2026-05-15T00:00:00Z"), price: 110 },
    { ts: Date.parse("2026-05-20T00:00:00Z"), price: 120 },
  ];
  it("最も近い点を返す", () => {
    expect(nearestPrice(s, Date.parse("2026-05-14T20:00:00Z"))).toBe(110);
  });
  it("離れすぎていたら null (別の相場の値を拾わない)", () => {
    expect(nearestPrice(s, Date.parse("2026-06-30T00:00:00Z"))).toBeNull();
  });
  it("価格 0 の点は無視する", () => {
    expect(nearestPrice([{ ts: 0, price: 0 }, ...s], 0, 1e15)).toBe(100);
  });
});
