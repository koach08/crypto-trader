import { describe, it, expect } from "vitest";
import { mergeExecutions, flattenArchive } from "./execution-archive";
import type { ExecutionRecord } from "../exchanges/types";

const ex = (id: string, ts: number): ExecutionRecord =>
  ({ id, timestamp: ts, pair: "BTC/JPY", side: "buy", price: 1, amount: 1, fee: 0 }) as ExecutionRecord;

describe("mergeExecutions", () => {
  it("取れなかった古い約定を消さない", () => {
    // 取引所が直近しか返さなくても、貯めた分は残る
    const merged = mergeExecutions([ex("a", 1), ex("b", 2)], [ex("c", 3)]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("同じ約定を二重に数えない", () => {
    const merged = mergeExecutions([ex("a", 1), ex("b", 2)], [ex("b", 2), ex("c", 3)]);
    expect(merged).toHaveLength(3);
  });

  it("時刻順に並べる (FIFO 計算がずれないように)", () => {
    const merged = mergeExecutions([ex("c", 3)], [ex("a", 1), ex("b", 2)]);
    expect(merged.map((r) => r.timestamp)).toEqual([1, 2, 3]);
  });
});

describe("flattenArchive", () => {
  it("ペアを跨いで時刻順に並べる", () => {
    const a = { byPair: { "BTC/JPY": [ex("a", 3)], "ETH/JPY": [ex("b", 1)] }, lastFetchedAt: 0 };
    expect(flattenArchive(a).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("対象ペアで絞れる", () => {
    const a = { byPair: { "BTC/JPY": [ex("a", 3)], "XLM/JPY": [ex("b", 1)] }, lastFetchedAt: 0 };
    expect(flattenArchive(a, ["BTC/JPY"]).map((r) => r.id)).toEqual(["a"]);
  });
});
