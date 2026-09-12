/**
 * コア目標比率は 85% のままでよいか、上げるべきか。
 *
 * 戦術枠を引退させた後、目標の残り (15%) は現金で寝る。用途は
 * 「利確 (+20% で 1/4 売る) → 5% 下で買い戻す」の回転資金だけ。
 * 上げれば含み益は増えるが、買い戻しの弾と下げの緩衝が減る。どちらが効くか。
 *
 * 本番と同じ純関数 (planCoreBuy / planCoreTakeProfit / applyCore*) を日足で回す。
 * 12 時間ごとの積立を再現するため 1 日 2 ステップ (同じ終値)。
 * bitFlyer の最小注文・往復コスト 0.36% を入れる。
 *
 * 採用条件を先に決める (後から都合よく選ばないため):
 *   重ならない 1 年区間 4 本すべてで最終 NAV が 85% を上回り、
 *   かつ最大ドローダウンがどの区間でも 5pt 以上悪化しないこと。
 *   1 つでも欠けたら 85% のまま。
 *
 * 注意: loadCoreConfig は targetPct を 0.95 で頭打ちにしている。
 *       100% は「上限を外した場合」の参考値。
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/core-target.harness.ts
 */
import { test } from "vitest";
import { cfgFor, loadWindows, simulate, COST_ONE_WAY, START_CASH } from "./core-sim";

test("コア目標比率の比較", async () => {
  const { bars, ts, slices } = await loadWindows();

  const TARGETS = [0.70, 0.85, 0.95, 1.00];
  const wins: Record<number, number> = {};
  const mddOk: Record<number, boolean> = {};
  for (const t of TARGETS) { wins[t] = 0; mddOk[t] = true; }

  console.log(`\n開始現金 ¥${START_CASH.toLocaleString()} / 往復コスト ${(COST_ONE_WAY * 200).toFixed(2)}% / 本番と同じ関数を 12h 刻みで回す\n`);
  for (const [from, to, label] of slices) {
    const isFull = label.startsWith("全期間");
    console.log(`================ ${label} ================`);
    console.log(["目標".padEnd(6), "最終NAV".padStart(10), "リターン".padStart(9), "最大DD".padStart(8), "利確確定".padStart(9), "買/売".padStart(8), "平均現金".padStart(9)].join(" "));
    const base = simulate(bars, ts, from, to, cfgFor(0.85));
    for (const t of TARGETS) {
      const r = t === 0.85 ? base : simulate(bars, ts, from, to, cfgFor(t));
      if (!isFull) {
        if (r.finalNav > base.finalNav) wins[t]++;
        if (r.mddPct < base.mddPct - 5) mddOk[t] = false;
      }
      const d = r.finalNav - base.finalNav;
      console.log([`${(t * 100).toFixed(0)}%`.padEnd(6), `¥${Math.round(r.finalNav).toLocaleString()}`.padStart(10),
        `${r.returnPct.toFixed(1)}%`.padStart(9), `${r.mddPct.toFixed(1)}%`.padStart(8),
        `¥${Math.round(r.realized).toLocaleString()}`.padStart(9), `${r.buys}/${r.sells}`.padStart(8),
        `${r.avgCashPct.toFixed(0)}%`.padStart(9),
        t === 0.85 ? "  (現行)" : `  ${d >= 0 ? "+" : ""}¥${Math.round(d).toLocaleString()} vs 85%`].join(" "));
    }
    console.log("");
  }
  const n = slices.length - 1;
  console.log("================ 採用判定 (重ならない区間のみ) ================");
  for (const t of TARGETS) {
    if (t === 0.85) continue;
    const ok = wins[t] === n && mddOk[t];
    console.log(`${(t * 100).toFixed(0)}%: NAV で 85% に勝った区間 ${wins[t]}/${n} / DD 5pt 以内 ${mddOk[t] ? "OK" : "NG"} → ${ok ? "採用条件を満たす" : "不採用"}${t === 1 ? " (※ 上限 0.95 を外す必要あり)" : ""}`);
  }
}, 10 * 60 * 1000);
