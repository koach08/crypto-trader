import { describe, it, expect } from "vitest";
import { slTriggerPercent } from "./engine";

/**
 * SL 発動ラインの符号規約を固定するテスト。
 *
 * ここが壊れると「買った次のサイクルで必ず投げ売り」という最悪の挙動に戻る。
 * (実際にそれで累計 173 取引 / 勝率 29% / -¥12,745 を出していた)
 */
describe("slTriggerPercent", () => {
  it("正の保存値は『エントリーから下』を意味し、負の変動率で発動する", () => {
    // RANGING の既定 SL 0.35% = エントリーから 0.35% 下で損切り
    expect(slTriggerPercent(0.35)).toBe(-0.35);
    expect(slTriggerPercent(0.6)).toBe(-0.6);
    expect(slTriggerPercent(2.0)).toBe(-2.0);
  });

  it("横ばい (変動 0%) では絶対に損切りが発動しない", () => {
    const changePercent = 0;
    for (const storedSL of [0.35, 0.6, 1.5, 2.0, 8.0]) {
      expect(changePercent <= slTriggerPercent(storedSL)).toBe(false);
    }
  });

  it("含み益が出ている間は損切りが発動しない", () => {
    const storedSL = 0.6;
    for (const changePercent of [0.1, 0.5, 1.2, 5.0]) {
      expect(changePercent <= slTriggerPercent(storedSL)).toBe(false);
    }
  });

  it("設計どおり損失が SL 幅に達したときだけ発動する", () => {
    const storedSL = 0.6; // 0.6% 下で損切り
    expect(-0.59 <= slTriggerPercent(storedSL)).toBe(false); // まだ発動しない
    expect(-0.6 <= slTriggerPercent(storedSL)).toBe(true);   // ちょうど発動
    expect(-1.5 <= slTriggerPercent(storedSL)).toBe(true);   // 超過も発動
  });

  it("負の保存値 (PTP/trailing の利益ロック) は利益側のラインになる", () => {
    // PTP が +5% で利益ロックした場合 stopLossPercent は -5 で保存される
    const locked = -5;
    expect(slTriggerPercent(locked)).toBe(5);
    // +6% まで伸びていれば維持、+5% まで後退したら決済
    expect(6 <= slTriggerPercent(locked)).toBe(false);
    expect(5 <= slTriggerPercent(locked)).toBe(true);
    expect(4 <= slTriggerPercent(locked)).toBe(true);
  });

  it("ブレイクイーブンロック (0) はエントリー価格割れで発動する", () => {
    expect(slTriggerPercent(0)).toBe(-0);
    expect(0.1 <= slTriggerPercent(0)).toBe(false);
    expect(-0.1 <= slTriggerPercent(0)).toBe(true);
  });
});
