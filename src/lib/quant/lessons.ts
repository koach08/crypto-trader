/**
 * Lessons learned: 振り返りから抽出したルールを集約 → 次の判断に活かす。
 *
 * - 個別の振り返り (reflection) を「意味的に同じパターン」でクラスタ化
 * - クラスタ化キー: category + action + regime + 確信度バケット
 *   (旧設計の preventionRule.slice(0,60) は LLM 文章のユニーク化で集約に失敗していた)
 * - 各サイクルの BUY/SELL 判断時にルールを照合
 * - 同じパターンで N 回負けてたら、次回は警告 or skip
 *
 * 設計:
 * - クラスタ 2 回以上発生 + 直近 30日以内 → active
 * - active ルールは最大 10 個まで
 */

import type { LossReflection } from "./reflection";
import { getReflections } from "./reflection";
import { loadData, saveData } from "../data";

export interface Lesson {
  /** クラスタキー: category::action::regime::confBucket */
  id: string;
  category: string;
  action: "BUY" | "SELL" | "HOLD";
  regime: string;
  /** confidence bucket (10pt 単位、例 60 = 60-69%) */
  confidenceBucket: number;
  /** 代表 rule 文 (表示用) */
  rule: string;
  /** 同じパターンで何回負けたか */
  occurrences: number;
  totalLoss: number;
  firstSeen: string;
  lastSeen: string;
  /** active = 判断時に適用される */
  active: boolean;
}

const LESSONS_FILE = "lessons-active";
const ACTIVATION_THRESHOLD = 2; // 2 回以上同パターンで損失 → active
const MAX_ACTIVE_LESSONS = 10;
const STALENESS_DAYS = 30;

type LessonAction = "BUY" | "SELL" | "HOLD";
function normalizeAction(a: string): LessonAction {
  const u = a.toUpperCase();
  return u === "BUY" || u === "SELL" ? u : "HOLD";
}

function clusterKey(r: LossReflection): string {
  const ctx = r.decisionContext;
  const confBucket = Math.floor(ctx.confidence / 10) * 10;
  return `${r.category}::${normalizeAction(ctx.action)}::${ctx.regime}::conf${confBucket}`;
}

/** 意味的クラスタリングで lessons を再構築 */
export async function rebuildLessonsFromReflections(): Promise<Lesson[]> {
  const reflections = await getReflections(200);
  const clusters: Record<string, {
    reflections: LossReflection[];
    sampleRule: string;
    category: string;
    action: "BUY" | "SELL" | "HOLD";
    regime: string;
    confidenceBucket: number;
  }> = {};

  for (const r of reflections) {
    const key = clusterKey(r);
    const ctx = r.decisionContext;
    if (!clusters[key]) {
      clusters[key] = {
        reflections: [],
        sampleRule: r.preventionRule,
        category: r.category,
        action: normalizeAction(ctx.action),
        regime: ctx.regime,
        confidenceBucket: Math.floor(ctx.confidence / 10) * 10,
      };
    }
    clusters[key].reflections.push(r);
  }

  const now = new Date();
  const lessons: Lesson[] = Object.entries(clusters)
    .map(([key, c]) => {
      const sortedRefls = [...c.reflections].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const totalLoss = c.reflections.reduce((s, r) => s + r.pnl, 0);
      const firstSeen = sortedRefls[0].timestamp;
      const lastSeen = sortedRefls[sortedRefls.length - 1].timestamp;
      const ageDays = (now.getTime() - new Date(lastSeen).getTime()) / (24 * 60 * 60 * 1000);
      const recentEnough = ageDays < STALENESS_DAYS;
      const active = c.reflections.length >= ACTIVATION_THRESHOLD && recentEnough;
      return {
        id: key,
        category: c.category,
        action: c.action,
        regime: c.regime,
        confidenceBucket: c.confidenceBucket,
        rule: c.sampleRule,
        occurrences: c.reflections.length,
        totalLoss,
        firstSeen,
        lastSeen,
        active,
      };
    })
    // 損失大きい順に並べる (損失合計の絶対値)
    .sort((a, b) => a.totalLoss - b.totalLoss);

  // active 上限制御
  let activeCount = 0;
  for (const l of lessons) {
    if (l.active && activeCount >= MAX_ACTIVE_LESSONS) {
      l.active = false;
    }
    if (l.active) activeCount++;
  }

  await saveData(LESSONS_FILE, lessons);
  return lessons;
}

export async function getActiveLessons(): Promise<Lesson[]> {
  const all = await loadData<Lesson[]>(LESSONS_FILE, []);
  return all.filter(l => l.active);
}

export async function getAllLessons(): Promise<Lesson[]> {
  return loadData<Lesson[]>(LESSONS_FILE, []);
}

/** 現在の判断コンテキスト */
export interface LessonCheckContext {
  action: "BUY" | "SELL" | "HOLD";
  pair: string;
  regime: string;
  fearGreed: number;
  rsi?: number;
  composite: number;
  confidence: number;
}

/**
 * クラスタ署名でマッチング: 現在の (action, regime, confBucket) が
 * 過去の損失クラスタと一致したら block 候補.
 */
export function matchLessons(ctx: LessonCheckContext, lessons: Lesson[]): {
  blocked: boolean;
  matched: { rule: string; reason: string }[];
} {
  const matched: { rule: string; reason: string }[] = [];
  const ctxBucket = Math.floor(ctx.confidence / 10) * 10;

  for (const l of lessons) {
    if (!l.active) continue;
    if (l.action !== ctx.action) continue;
    if (l.regime !== ctx.regime) continue;
    // 確信度バケットは ±1 段階まで許容 (60-79 で 70-bucket lesson にもヒット)
    if (Math.abs(l.confidenceBucket - ctxBucket) > 10) continue;

    matched.push({
      rule: l.rule,
      reason: `過去 ${l.occurrences} 回 ${l.regime}/${l.action}/conf${l.confidenceBucket} で合計 ¥${Math.round(l.totalLoss).toLocaleString()} の損失`,
    });
  }

  // 1 件マッチでも、強い損失パターン (-¥50 以上) なら block
  const strongBlock = matched.some(m => /-¥[5-9]\d|-¥\d{3,}/.test(m.reason));
  const blocked = matched.length >= 2 || strongBlock;

  return { blocked, matched };
}
