/**
 * コア枠の積み方を変えると成績は上がるか。
 *
 * 本番は「12時間ごとに一定額」で、価格を一切見ていない。
 * 「安いときに多く買う」ほうが取得平均は下がるはずだが、実際に効くのか。
 *
 * 測り方の注意 (最初の版で踏んだ穴):
 *   5年/2年/1年は入れ子で、同じ相場を3回数えているだけだった。
 *   ここでは **重ならない1年ごとの区間** で測る。
 *   投じた総額も並べて出す (額が違うのに率だけ比べると誤読するため)。
 *
 * 採用条件を先に決めておく (後から都合よく選ばないため):
 *   重ならない区間の **すべて** で、3ペア平均が定額積立を上回ること。
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/dca-method.harness.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test } from "vitest";
import type { OHLCVBar } from "../src/lib/types";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
const SYMBOLS: Record<string, string> = { "BTC/JPY": "BTC-JPY", "ETH/JPY": "ETH-JPY", "XRP/JPY": "XRP-JPY" };

async function fetchDaily(pair: string): Promise<OHLCVBar[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const symbol = SYMBOLS[pair];
  const cache = path.join(CACHE_DIR, `${symbol}-daily.json`);
  if (existsSync(cache)) {
    const raw = JSON.parse(readFileSync(cache, "utf8")) as { fetchedAt: number; bars: OHLCVBar[] };
    if (Date.now() - raw.fetchedAt < 12 * 60 * 60 * 1000) return raw.bars;
  }
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=1d`,
    { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < (r?.timestamp ?? []).length; i++) {
    const close = q?.close?.[i];
    if (close == null) continue;
    bars.push({ timestamp: r.timestamp[i] * 1000, open: close, high: close, low: close, close, volume: 0 });
  }
  writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), bars }));
  return bars;
}

const sma = (a: number[], n: number, i: number) =>
  i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n;

export type DcaMode = "fixed" | "dip" | "strongdip";

/** MA50 からの乖離で積む額の倍率を決める。本番実装と同じ式にしておく。 */
export function dipMultiplier(mode: DcaMode, deviation: number | null): number {
  if (mode === "fixed" || deviation == null) return 1;
  if (mode === "dip") return deviation < 0 ? 1.5 : 0.5;
  return deviation < -0.1 ? 2 : deviation < 0 ? 1.2 : 0.4;
}

function simulate(closes: number[], from: number, to: number, mode: DcaMode, everyN: number) {
  const budgetPerBuy = 1000;
  let amount = 0, invested = 0, buys = 0;
  for (let i = from; i < to; i++) {
    if (i % everyN !== 0) continue;
    const ma = sma(closes, 50, i);
    const dev = ma ? (closes[i] - ma) / ma : null;
    const spend = budgetPerBuy * dipMultiplier(mode, dev);
    amount += spend / closes[i];
    invested += spend;
    buys++;
  }
  const value = amount * closes[to - 1];
  return { returnPercent: invested > 0 ? ((value - invested) / invested) * 100 : 0, invested, buys };
}

const MODES: Array<[DcaMode, string]> = [
  ["fixed", "定額 (本番)"],
  ["dip", "押し目重視 1.5x/0.5x"],
  ["strongdip", "強い押し目 2x/1.2x/0.4x"],
];

test("積立方式の比較 (重ならない区間)", async () => {
  const bars: Record<string, number[]> = {};
  for (const p of Object.keys(SYMBOLS)) bars[p] = (await fetchDaily(p)).map(b => b.close);

  const len = Math.min(...Object.values(bars).map(b => b.length));
  const WARMUP = 50, SLICE = 365;
  const slices: Array<[number, number, string]> = [];
  for (let end = len; end - SLICE >= WARMUP; end -= SLICE) slices.push([end - SLICE, end, ""]);
  slices.reverse();
  const raw = await fetchDaily("BTC/JPY");
  for (const s of slices) {
    s[2] = `${new Date(raw[s[0]].timestamp).toISOString().slice(0, 7)}〜${new Date(raw[s[1] - 1].timestamp).toISOString().slice(0, 7)}`;
  }

  for (const everyN of [1, 2, 3, 7, 14]) {
    console.log(`\n########## ${everyN}日ごとに積む ##########`);
    const wins: Record<string, number> = {};
    const yenWins: Record<string, number> = {};
    for (const [from, to, label] of slices) {
      console.log(`\n================ ${label} ================`);
      console.log(["方式".padEnd(24), "BTC".padStart(8), "ETH".padStart(8), "XRP".padStart(8), "平均".padStart(8), "投じた額".padStart(10), "利益(円)".padStart(11)].join(" "));
      let base = 0, baseProfit = 0;
      for (const [mode, name] of MODES) {
        const rows: number[] = [];
        const investedByPair: number[] = [];
        let invested = 0;
        for (const pair of Object.keys(SYMBOLS)) {
          const r = simulate(bars[pair], from, to, mode, everyN);
          rows.push(r.returnPercent);
          investedByPair.push(r.invested);
          invested += r.invested;
        }
        const avg = rows.reduce((s, v) => s + v, 0) / rows.length;
        if (mode === "fixed") base = avg;
        else if (avg > base) wins[name] = (wins[name] ?? 0) + 1;
        const profitJPY = rows.reduce((s, v, k) => s + investedByPair[k] * (v / 100), 0);
        console.log([name.padEnd(24), ...rows.map(v => `${v.toFixed(1)}%`.padStart(8)),
          `${avg.toFixed(1)}%`.padStart(8), `¥${Math.round(invested).toLocaleString()}`.padStart(10),
          `¥${Math.round(profitJPY).toLocaleString()}`.padStart(11)].join(" "));
        if (mode === "fixed") baseProfit = profitJPY; else if (profitJPY > baseProfit) yenWins[name] = (yenWins[name] ?? 0) + 1;
      }
    }
    console.log(`\n---- ${everyN}日ごと の採用判定 ----`);
    for (const [mode, name] of MODES) {
      if (mode === "fixed") continue;
      const w = wins[name] ?? 0;
      const yw = yenWins[name] ?? 0;
      console.log(`${name.padEnd(24)} 率 ${w}/${slices.length} ・ 円 ${yw}/${slices.length} → ${w === slices.length && yw === slices.length ? "率も円も全区間で勝ち = 採用" : "不採用"}`);
    }
  }
}, 10 * 60 * 1000);
