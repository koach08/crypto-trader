/**
 * Grid trader — 短期上下取り (AI 動的 sizing).
 *
 * 思想: 仮想通貨は上下繰り返す → 範囲内で買い指値/売り指値を並べ機械的に
 * round-trip 利益を取る. 「いくら投入するか」は AI が市場状況見て自己判断.
 *
 * 設計:
 *   1. cycle 内で「grid 候補 pair」を選別 (ボラ適度、流動性あり)
 *   2. AI に market context (NAV, intel, F&G, regime) を渡し、
 *      pair 別の grid 投入額 + range % + level 数を返してもらう
 *   3. 既存 grid 状態と diff を取り、足りない level に指値発注 / 余分削除
 *   4. 約定したら反対側に rebalance 指値を出し直す
 *
 * 安全:
 *   - kill switch 発火中は新規 grid 作成停止
 *   - capital tier 範囲内
 *   - 既存 spot position と独立 (別 namespace で管理)
 *
 * MVP 範囲 (今回実装):
 *   - AI に sizing 依頼 + 状態保存
 *   - 既存 marketBuy/limitSell を活用した擬似 grid
 *   - 完全な限定注文管理は次の iteration
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadData, saveData } from "../data";
import type { AggregatedIntel } from "../intel/aggregator";

const STATE_FILE = "grid-trader-state";
const PLAN_FILE = "grid-trader-plan";

export interface GridPlan {
  pair: string;
  capitalJPY: number;       // この pair に投入する総額
  rangePercent: number;     // 中心価格から ±X% の範囲
  numLevels: number;        // 上下それぞれの level 数
  reasoning: string;        // AI の根拠
  recommendedCenter?: number; // 中心価格 (price 基準)
}

export interface AggregatedGridPlan {
  generatedAt: string;
  totalCapitalJPY: number;
  plans: GridPlan[];
  marketSnapshot: {
    nav: number;
    intelTotal: number;
    intelVerdict: string;
    fearGreed: number;
  };
  reasoning: string;
}

export interface GridLevel {
  pair: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  status: "pending" | "filled" | "cancelled";
  placedAt: string;
}

export interface GridState {
  pair: string;
  centerPrice: number;
  levels: GridLevel[];
  realizedPnL: number;
  trades: number;
  updatedAt: string;
}

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  if (_ai) return _ai;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _ai = new Anthropic({ apiKey: key });
  return _ai;
}

/**
 * AI に「市場状況見て各 pair の grid 投入計画を立てて」と依頼.
 */
export async function askAIForGridPlan(input: {
  nav: number;
  capitalAvailable: number;
  pairs: string[];
  fearGreed: number;
  intel: AggregatedIntel | null;
  priceMap: Record<string, number>;
}): Promise<AggregatedGridPlan | null> {
  const ai = getAI();
  if (!ai) {
    console.warn("[grid] ANTHROPIC_API_KEY 未設定、AI sizing skip");
    return null;
  }

  const intelStr = input.intel
    ? `total ${input.intel.totalScore} (${input.intel.verdict}). 投機 ${input.intel.categories.speculation.score} / 実需 ${input.intel.categories.utility.score} / マクロ ${input.intel.categories.macro.score}`
    : "intel 取得失敗";

  const pricesStr = Object.entries(input.priceMap)
    .map(([p, price]) => `  ${p}: ¥${price.toLocaleString()}`)
    .join("\n");

  const prompt = `あなたは crypto bot の grid trading ストラテジスト. お金を預かってる責任ある投資家として、
過度に攻めも守りもせず、冷静に「上下繰り返し取り」の投入計画を立ててください.

## 現在の状況
- NAV: ¥${input.nav.toLocaleString()}
- Grid に使える資金 (capital available): ¥${input.capitalAvailable.toLocaleString()}
- F&G: ${input.fearGreed}
- Intel: ${intelStr}
- 対象 pair の現在価格:
${pricesStr}

## 指示
各 pair に対して以下を決めてください:
- capitalJPY: その pair の grid 全体に投入する円額 (合計が capitalAvailable を超えない、0 = grid 構築しない)
- rangePercent: 中心価格から ±X% の範囲 (1-10 が現実的)
- numLevels: 上下それぞれの level 数 (2-5)
- reasoning: なぜこの sizing にしたか (1-2 行)

## 判断方針 (重要)
- intel score が強い方向に偏ってる時は、その方向に偏った grid (例: 強気なら buy 多め)
- ボラ高い時は range 広げる、低い時は狭く
- 全体の F&G で攻め/守りの基本トーンを決める:
  - Extreme Fear (≤25): バリュー圏、capital 大きめ
  - Extreme Greed (≥75): 高値圏、capital 小さめ
- 「儲かるぞ」と煽らない、冷静かつ責任ある判断

## 期待する JSON 形式
{
  "plans": [
    {"pair": "BTC/JPY", "capitalJPY": <数値>, "rangePercent": <数値>, "numLevels": <数値>, "reasoning": "<根拠>"},
    {"pair": "ETH/JPY", ...},
    ...
  ],
  "reasoning": "<全体方針 2-3 行>"
}
JSON のみ返答.`;

  try {
    const resp = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.filter((c): c is Anthropic.TextBlock => c.type === "text").map(c => c.text).join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[grid] JSON 抽出失敗");
      return null;
    }
    const sanitized = jsonMatch[0].replace(/:\s*\+(\d)/g, ": $1").replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(sanitized) as { plans?: GridPlan[]; reasoning?: string };
    const plans: GridPlan[] = (parsed.plans ?? []).map(p => ({
      pair: String(p.pair),
      capitalJPY: Math.max(0, Math.min(input.capitalAvailable, Number(p.capitalJPY) || 0)),
      rangePercent: Math.max(0.5, Math.min(15, Number(p.rangePercent) || 3)),
      numLevels: Math.max(1, Math.min(10, Math.round(Number(p.numLevels) || 3))),
      reasoning: String(p.reasoning ?? "").slice(0, 200),
      recommendedCenter: input.priceMap[String(p.pair)],
    }));

    // 合計 capital の clamp
    const totalReq = plans.reduce((s, p) => s + p.capitalJPY, 0);
    if (totalReq > input.capitalAvailable && totalReq > 0) {
      const scale = input.capitalAvailable / totalReq;
      plans.forEach(p => { p.capitalJPY = Math.round(p.capitalJPY * scale); });
    }

    const aggregated: AggregatedGridPlan = {
      generatedAt: new Date().toISOString(),
      totalCapitalJPY: input.capitalAvailable,
      plans,
      marketSnapshot: {
        nav: input.nav,
        intelTotal: input.intel?.totalScore ?? 0,
        intelVerdict: input.intel?.verdict ?? "—",
        fearGreed: input.fearGreed,
      },
      reasoning: String(parsed.reasoning ?? "").slice(0, 500),
    };
    await saveData(PLAN_FILE, aggregated);
    console.log(`[grid] AI plan generated: ${plans.length} pairs, capital ¥${input.capitalAvailable}`);
    for (const p of plans) {
      console.log(`  ${p.pair}: ¥${p.capitalJPY} 投入 / range ±${p.rangePercent}% / ${p.numLevels} levels`);
    }
    return aggregated;
  } catch (e) {
    console.warn("[grid] AI 失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Grid level を計算 (中心価格から ±range% を numLevels に等分割).
 * capitalJPY を level 数で割って各 level の amount を決定.
 */
export function buildGridLevels(plan: GridPlan, centerPrice: number): GridLevel[] {
  if (plan.capitalJPY <= 0 || centerPrice <= 0) return [];
  const levels: GridLevel[] = [];
  const perLevelJPY = plan.capitalJPY / (plan.numLevels * 2);
  const now = new Date().toISOString();
  for (let i = 1; i <= plan.numLevels; i++) {
    const offset = (plan.rangePercent / 100) * (i / plan.numLevels);
    const buyPrice = centerPrice * (1 - offset);
    const sellPrice = centerPrice * (1 + offset);
    levels.push({
      pair: plan.pair, side: "buy", price: buyPrice, amount: perLevelJPY / buyPrice,
      status: "pending", placedAt: now,
    });
    levels.push({
      pair: plan.pair, side: "sell", price: sellPrice, amount: perLevelJPY / sellPrice,
      status: "pending", placedAt: now,
    });
  }
  return levels;
}

export async function getCurrentGridPlan(): Promise<AggregatedGridPlan | null> {
  return await loadData<AggregatedGridPlan | null>(PLAN_FILE, null);
}

export async function getGridState(pair: string): Promise<GridState | null> {
  const all = await loadData<Record<string, GridState>>(STATE_FILE, {});
  return all[pair] ?? null;
}

export async function saveGridState(state: GridState): Promise<void> {
  const all = await loadData<Record<string, GridState>>(STATE_FILE, {});
  all[state.pair] = state;
  await saveData(STATE_FILE, all);
}

/**
 * AI sizing → grid plan → 実行までの一連. cycle 内から呼ぶ.
 * 実取引 (limit order) は API 制約あるので MVP では「擬似 grid」=
 * 価格が買い指値 level に届いたら marketBuy、売り level に届いたら marketSell.
 */
export async function runGridCycle(ctx: {
  nav: number;
  capitalAvailable: number;
  pairs: string[];
  fearGreed: number;
  intel: AggregatedIntel | null;
  tickerMap: Record<string, number>; // pair → 現在価格
  marketBuy: (pair: string, jpyAmount: number) => Promise<{ ok: boolean; fillPrice?: number; amount?: number }>;
  marketSell: (pair: string, baseAmount: number) => Promise<{ ok: boolean; fillPrice?: number; amount?: number }>;
}): Promise<void> {
  // 1. 既存 plan を確認、無いか 1 時間以上古いなら AI で再生成
  const existing = await getCurrentGridPlan();
  const stale = !existing || Date.now() - new Date(existing.generatedAt).getTime() > 60 * 60 * 1000;
  let plan: AggregatedGridPlan | null = existing;
  if (stale) {
    plan = await askAIForGridPlan({
      nav: ctx.nav,
      capitalAvailable: ctx.capitalAvailable,
      pairs: ctx.pairs,
      fearGreed: ctx.fearGreed,
      intel: ctx.intel,
      priceMap: ctx.tickerMap,
    });
  }
  if (!plan) return;

  // 2. 各 pair の擬似 grid 実行: 既存 state の各 level を「価格到達したか」チェック → 約定処理
  for (const pairPlan of plan.plans) {
    if (pairPlan.capitalJPY <= 0) continue;
    const currentPrice = ctx.tickerMap[pairPlan.pair];
    if (!currentPrice) continue;

    let state = await getGridState(pairPlan.pair);
    // 初回 or center 大きくずれてる → 新規構築
    const driftPct = state ? Math.abs(currentPrice - state.centerPrice) / state.centerPrice * 100 : 100;
    if (!state || driftPct > pairPlan.rangePercent) {
      state = {
        pair: pairPlan.pair,
        centerPrice: currentPrice,
        levels: buildGridLevels(pairPlan, currentPrice),
        realizedPnL: state?.realizedPnL ?? 0,
        trades: state?.trades ?? 0,
        updatedAt: new Date().toISOString(),
      };
      console.log(`[grid] ${pairPlan.pair} grid 再構築: center ¥${currentPrice.toFixed(0)}, ±${pairPlan.rangePercent}%, ${state.levels.length / 2} levels`);
    }

    // 各 level チェック: 価格が買い level を割ったら marketBuy / 売り level に達したら marketSell
    for (const level of state.levels) {
      if (level.status !== "pending") continue;
      if (level.side === "buy" && currentPrice <= level.price) {
        const jpyAmount = level.amount * level.price;
        const result = await ctx.marketBuy(pairPlan.pair, jpyAmount).catch(() => ({ ok: false }));
        if (result.ok) {
          level.status = "filled";
          state.trades++;
          console.log(`[grid] ${pairPlan.pair} BUY filled @ ¥${currentPrice.toFixed(0)} (level ¥${level.price.toFixed(0)})`);
        }
      } else if (level.side === "sell" && currentPrice >= level.price) {
        const result = await ctx.marketSell(pairPlan.pair, level.amount).catch(() => ({ ok: false }));
        if (result.ok) {
          level.status = "filled";
          state.trades++;
          console.log(`[grid] ${pairPlan.pair} SELL filled @ ¥${currentPrice.toFixed(0)} (level ¥${level.price.toFixed(0)})`);
        }
      }
    }

    state.updatedAt = new Date().toISOString();
    await saveGridState(state);
  }
}
