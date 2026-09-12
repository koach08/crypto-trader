/**
 * コア枠の「利確 → 買い戻し」の条件は今のままでよいか。
 *
 * core-target の測定で、目標 85% でも実際は 20〜48% が現金だった。
 * 利確 (+20% で 1/4 売る) で出た現金が、再エントリー条件 (売値の 5% 下) を待って
 * 寝ている。現金を寝かせている主因は目標比率ではなくここ。
 *
 * 対照群に「利確しない (積んで持つだけ)」を入れる。買い持ちが全てに勝っていた以上、
 * 利確の仕組み自体が足を引っ張っている可能性を先に潰す。
 *
 * 採用条件を先に決める (後から都合よく選ばないため):
 *   重ならない 1 年区間すべてで最終 NAV が現行を上回り、
 *   かつ最大 DD がどの区間でも 5pt 以上悪化しないこと。1 つでも欠けたら現行のまま。
 *
 * 候補は少なく絞る (多く試すほど偶然の当たりが混ざる):
 *   再エントリー: 0% / 2% / 5%(現行) / 10%
 *   利確: なし / +10% / +20%(現行) / +30% 、売る割合 1/4(現行) / 1/2
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/core-reentry.harness.ts
 */
import { test } from "vitest";
import { cfgFor, loadWindows, simulate, COST_ONE_WAY, START_CASH } from "./core-sim";
import type { CoreHoldConfig } from "../src/lib/trading/core-holding";

type Cand = { label: string; over: Partial<CoreHoldConfig> };

const CURRENT: Cand = { label: "現行 (利確+20%/売1/4/再入5%)", over: {} };
const CANDS: Cand[] = [
  { label: "利確なし (積んで持つだけ)", over: { takeProfitPct: 0 } },
  { label: "再入 0% (すぐ買い戻す)", over: { reentryDiscountPct: 0 } },
  { label: "再入 2%", over: { reentryDiscountPct: 0.02 } },
  { label: "再入 10%", over: { reentryDiscountPct: 0.10 } },
  { label: "利確 +10%", over: { takeProfitPct: 0.10 } },
  { label: "利確 +30%", over: { takeProfitPct: 0.30 } },
  { label: "売る割合 1/2", over: { takeProfitFraction: 0.5 } },
];

test("再エントリー / 利確条件の比較", async () => {
  const { bars, ts, slices } = await loadWindows();
  const wins: Record<string, number> = {};
  const mddOk: Record<string, boolean> = {};
  const fullNav: Record<string, number> = {};
  for (const c of CANDS) { wins[c.label] = 0; mddOk[c.label] = true; }

  console.log(`\n開始現金 ¥${START_CASH.toLocaleString()} / 往復コスト ${(COST_ONE_WAY * 200).toFixed(2)}% / 目標 85% 固定\n`);
  for (const [from, to, label] of slices) {
    const isFull = label.startsWith("全期間");
    console.log(`================ ${label} ================`);
    console.log(["条件".padEnd(28), "最終NAV".padStart(10), "最大DD".padStart(8), "利確確定".padStart(9), "買/売".padStart(8), "平均現金".padStart(8), "vs現行".padStart(10)].join(" "));
    const base = simulate(bars, ts, from, to, cfgFor(0.85));
    const row = (name: string, r: ReturnType<typeof simulate>, isBase = false) =>
      console.log([name.padEnd(28), `¥${Math.round(r.finalNav).toLocaleString()}`.padStart(10),
        `${r.mddPct.toFixed(1)}%`.padStart(8), `¥${Math.round(r.realized).toLocaleString()}`.padStart(9),
        `${r.buys}/${r.sells}`.padStart(8), `${r.avgCashPct.toFixed(0)}%`.padStart(8),
        isBase ? "—".padStart(10) : `${r.finalNav - base.finalNav >= 0 ? "+" : ""}¥${Math.round(r.finalNav - base.finalNav).toLocaleString()}`.padStart(10)].join(" "));
    row(CURRENT.label, base, true);
    for (const c of CANDS) {
      const r = simulate(bars, ts, from, to, cfgFor(0.85, c.over));
      if (!isFull) {
        if (r.finalNav > base.finalNav) wins[c.label]++;
        if (r.mddPct < base.mddPct - 5) mddOk[c.label] = false;
      } else fullNav[c.label] = r.finalNav - base.finalNav;
      row(c.label, r);
    }
    console.log("");
  }
  const n = slices.length - 1;
  console.log("================ 採用判定 (重ならない区間のみ) ================");
  for (const c of CANDS) {
    const ok = wins[c.label] === n && mddOk[c.label];
    console.log(`${c.label.padEnd(28)} 勝ち ${wins[c.label]}/${n} / DD ${mddOk[c.label] ? "OK" : "NG"} / 全期間 ${fullNav[c.label] >= 0 ? "+" : ""}¥${Math.round(fullNav[c.label]).toLocaleString()} → ${ok ? "採用条件を満たす" : "不採用"}`);
  }
}, 10 * 60 * 1000);
