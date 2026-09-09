/**
 * ゲートを変えるべきか。ただし前回の測り方には穴が2つあった。
 *
 *  穴1: 売買コストがゼロ。速いゲートほど出入りが増えるので、
 *       コストを入れないと速いゲートが必ず有利に出る。
 *  穴2: 5年/2年/1年が入れ子になっている。5年は2年を含み、2年は1年を含む。
 *       「全窓で勝ち」と言っても、実質は同じ相場を3回数えているだけ。
 *
 * ここでは (a) 往復コストを引き、(b) **重ならない1年ごとの区間**で測る。
 * 採用条件を先に決める: 重ならない区間の過半で買い持ちに勝つこと。
 *
 * 実行: npx vitest run --config vitest.harness.config.ts scripts/gate-cost.harness.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { test } from "vitest";
import type { OHLCVBar } from "../src/lib/types";

const CACHE_DIR = path.resolve(__dirname, "../data/backtest-cache");
const SYMBOLS: Record<string, string> = { "BTC/JPY": "BTC-JPY", "ETH/JPY": "ETH-JPY", "XRP/JPY": "XRP-JPY" };

/** bitFlyer の実測に合わせる: 手数料 0.15% + 実測スリッページ 0.03% を片道に。 */
const COST_ONE_WAY = 0.0018;

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

/**
 * ゲートが開いている日だけ保有。状態が変わる日に往復コストを引く。
 * MA は区間の外 (助走部分) も使って計算する。区間の先頭で MA が無いと
 * 「最初の200日はゲートが閉じている」という嘘の結果になるため。
 */
function gatedReturn(closes: number[], from: number, to: number, fast: number, slow: number) {
  let equity = 1, openDays = 0, total = 0, switches = 0;
  let held = false;
  for (let i = from; i < to - 1; i++) {
    total++;
    const mf = sma(closes, fast, i), ms = sma(closes, slow, i);
    const open = mf != null && ms != null && closes[i] > mf && mf > ms;
    if (open !== held) { equity *= 1 - COST_ONE_WAY; switches++; held = open; }
    if (open) { openDays++; equity *= closes[i + 1] / closes[i]; }
  }
  if (held) { equity *= 1 - COST_ONE_WAY; switches++; }
  return {
    returnPercent: (equity - 1) * 100,
    openPercent: total ? (openDays / total) * 100 : 0,
    switches,
  };
}

const PARAMS: Array<[number, number, string]> = [
  [50, 200, "本番 (50/200)"],
  [20, 100, "やや速い (20/100)"],
  [20, 50, "速い (20/50)"],
  [10, 30, "かなり速い (10/30)"],
];

test("ゲート比較 (コスト込み・重ならない区間)", async () => {
  const bars: Record<string, OHLCVBar[]> = {};
  for (const p of Object.keys(SYMBOLS)) bars[p] = await fetchDaily(p);

  const len = Math.min(...Object.values(bars).map(b => b.length));
  const WARMUP = 200;           // MA200 の助走
  const SLICE = 365;
  // 直近から 365日ずつ、重ならないように切る。助走が確保できる分だけ。
  const slices: Array<[number, number, string]> = [];
  for (let end = len; end - SLICE >= WARMUP; end -= SLICE) {
    const start = end - SLICE;
    const d = new Date(bars["BTC/JPY"][start].timestamp);
    const e = new Date(bars["BTC/JPY"][end - 1].timestamp);
    slices.push([start, end, `${d.toISOString().slice(0, 7)}〜${e.toISOString().slice(0, 7)}`]);
  }
  slices.reverse();

  console.log(`\n往復コスト ${(COST_ONE_WAY * 2 * 100).toFixed(2)}% を引いた結果。重ならない ${slices.length} 区間。\n`);

  const wins: Record<string, number> = {};
  const totalRet: Record<string, number> = {};
  let bhTotal = 0;

  for (const [start, end, label] of slices) {
    console.log(`================ ${label} ================`);
    console.log(["ゲート".padEnd(18), "開放".padStart(6), "出入り".padStart(7), "ゲート運用".padStart(11), "買い持ち".padStart(10), "差".padStart(9)].join(" "));
    let bhAvg = 0;
    for (const pair of Object.keys(SYMBOLS)) {
      bhAvg += (bars[pair][end - 1].close / bars[pair][start].close - 1) * 100;
    }
    bhAvg /= 3;
    bhTotal += bhAvg;
    for (const [f, sl, name] of PARAMS) {
      let sumR = 0, sumO = 0, sumS = 0;
      for (const pair of Object.keys(SYMBOLS)) {
        const closes = bars[pair].map(b => b.close);
        const g = gatedReturn(closes, start, end, f, sl);
        sumR += g.returnPercent; sumO += g.openPercent; sumS += g.switches;
      }
      const r = sumR / 3, o = sumO / 3, s = sumS / 3;
      totalRet[name] = (totalRet[name] ?? 0) + r;
      if (r > bhAvg) wins[name] = (wins[name] ?? 0) + 1;
      console.log([name.padEnd(18), `${o.toFixed(0)}%`.padStart(6), s.toFixed(0).padStart(7),
        `${r.toFixed(1)}%`.padStart(11), `${bhAvg.toFixed(1)}%`.padStart(10),
        `${(r - bhAvg >= 0 ? "+" : "")}${(r - bhAvg).toFixed(1)}pt`.padStart(9)].join(" "));
    }
    console.log("");
  }

  console.log("================ 採用判定 ================");
  console.log(`買い持ち 合計 ${bhTotal.toFixed(1)}%  (${slices.length}区間)`);
  for (const [, , name] of PARAMS) {
    const w = wins[name] ?? 0;
    const verdict = w > slices.length / 2 ? "過半で勝ち = 検討に値する" : `${w}/${slices.length} 区間のみ = 不採用`;
    console.log(`${name.padEnd(18)} 合計 ${(totalRet[name] ?? 0).toFixed(1).padStart(7)}%  勝ち ${w}/${slices.length}  → ${verdict}`);
  }
}, 10 * 60 * 1000);
