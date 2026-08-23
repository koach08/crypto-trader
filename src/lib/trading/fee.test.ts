import { describe, it, expect } from "vitest";
import { feeToJPY } from "./fee";

describe("feeToJPY", () => {
  it("基軸通貨建ての手数料を円に直す", () => {
    // 実データ: XRP 売り 0.590653 XRP を ¥187.80 で、手数料 0.000708 XRP
    const jpy = feeToJPY({ fee: 0.000708, feeCurrency: "XRP", pair: "XRP/JPY", priceJPY: 187.8 });
    expect(jpy).toBeCloseTo(0.1330, 3);
  });

  it("通貨が分からなければ換算しない (掛け算で損益を壊さない)", () => {
    // BTC 建てと決めつけて掛けると 1200万倍になる。分からないものは触らない。
    expect(feeToJPY({ fee: 50, pair: "BTC/JPY", priceJPY: 12_000_000 })).toBe(50);
  });

  it("円建てで来ていればそのまま", () => {
    expect(feeToJPY({ fee: 15, feeCurrency: "JPY", pair: "BTC/JPY", priceJPY: 12_000_000 })).toBe(15);
  });

  it("知らない通貨は計上しない (誤った換算で数字を作らない)", () => {
    expect(feeToJPY({ fee: 3, feeCurrency: "USD", pair: "BTC/JPY", priceJPY: 12_000_000 })).toBe(0);
  });

  it("価格が取れなければ 0", () => {
    expect(feeToJPY({ fee: 0.001, feeCurrency: "BTC", pair: "BTC/JPY", priceJPY: 0 })).toBe(0);
  });
});
