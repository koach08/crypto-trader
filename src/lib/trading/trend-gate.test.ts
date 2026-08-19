import { describe, it, expect } from "vitest";
import { evaluateTrend, decideByTrend } from "./trend-gate";
import type { OHLCVBar } from "../types";

/**
 * トレンドゲートの向きを固定する。
 * ここが逆になると「下降トレンドで買い続ける」元の負けパターンに戻るので、
 * 符号規約をテストで縛っておく (sl-trigger.test.ts と同じ趣旨)。
 */
function bars(closes: number[]): OHLCVBar[] {
  return closes.map((c, i) => ({
    timestamp: i * 86_400_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

/** n 本の右肩上がり / 右肩下がり系列 */
function ramp(n: number, from: number, to: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

describe("evaluateTrend", () => {
  it("バーが足りなければ null (呼び出し側でフォールバックを決める)", () => {
    expect(evaluateTrend(bars(ramp(10, 100, 200)))).toBeNull();
    expect(evaluateTrend(null)).toBeNull();
  });

  it("上昇局面では upTrend、ショートは許さない", () => {
    const t = evaluateTrend(bars(ramp(300, 100, 400)));
    expect(t).not.toBeNull();
    expect(t!.upTrend).toBe(true);
    expect(t!.belowFast).toBe(false);
    expect(t!.confirmedDownTrend).toBe(false);
    expect(t!.degraded).toBe(false);
  });

  it("下降局面では upTrend にならず、確定下降トレンドと判定する", () => {
    const t = evaluateTrend(bars(ramp(300, 400, 100)));
    expect(t!.upTrend).toBe(false);
    expect(t!.belowFast).toBe(true);
    expect(t!.confirmedDownTrend).toBe(true);
  });

  it("上昇トレンド中の押し目は「MA50 割れ」でもショート条件を満たさない", () => {
    // 長く上げたあと直近だけ小さく下げる = MA50 は割るが MA200 は上のまま
    const closes = [...ramp(280, 100, 400), ...ramp(20, 400, 360)];
    const t = evaluateTrend(bars(closes));
    expect(t!.belowFast).toBe(true); // ロングは畳む
    expect(t!.confirmedDownTrend).toBe(false); // だがショートは打たない
    expect(t!.upTrend).toBe(false);
  });

  it("上昇トレンドかつ未保有なら BUY を出す (上げ相場で買えないと意味がない)", () => {
    const up = evaluateTrend(bars(ramp(300, 100, 400)));
    expect(decideByTrend(up, false).action).toBe("BUY");
    // 既に持っているなら買い増さない
    expect(decideByTrend(up, true).action).toBe("HOLD");
  });

  it("保有中に日足が MA50 を割ったら撤退、min hold を抜ける接頭辞を付ける", () => {
    const down = evaluateTrend(bars(ramp(300, 400, 100)));
    const d = decideByTrend(down, true);
    expect(d.action).toBe("SELL");
    expect(d.reason.startsWith("[MAルール撤退")).toBe(true);
  });

  it("下降トレンドで未保有なら何もしない (落ちるナイフを掴まない)", () => {
    const down = evaluateTrend(bars(ramp(300, 400, 100)));
    expect(decideByTrend(down, false).action).toBe("HOLD");
  });

  it("トレンド判定不能なら待機 (分からないときに賭けない)", () => {
    expect(decideByTrend(null, false).action).toBe("HOLD");
    expect(decideByTrend(null, true).action).toBe("HOLD");
  });

  it("MA200 が計算できないときは degraded で MA50 のみ判定", () => {
    const t = evaluateTrend(bars(ramp(120, 100, 300)));
    expect(t!.degraded).toBe(true);
    expect(t!.slow).toBeNull();
    expect(t!.upTrend).toBe(true);
    // 確定下降トレンドは MA200 無しでは判定しない (誤ショートを防ぐ)
    expect(t!.confirmedDownTrend).toBe(false);
  });
});
