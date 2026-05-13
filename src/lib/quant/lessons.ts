/**
 * Lessons learned: 振り返りから抽出したルールを集約 → 次の判断に活かす。
 *
 * - 個別の振り返り (reflection) → 似たもの集約 → 重み付きルール (lessons)
 * - 各サイクルの BUY/SELL 判断時にルールを照合
 * - 同じパターンで N 回負けてたら、次回は警告 or skip
 *
 * 設計:
 * - ルールの「強度」は発生回数で決まる (3回以上で active)
 * - 古いルール (30日以上前) は弱める (時間減衰)
 * - 過剰禁止防止のため、active ルールは最大 10 個まで
 */

import type { LossReflection } from "./reflection";
import { getReflections } from "./reflection";
import { loadData, saveData } from "../data";

export interface Lesson {
  id: string;
  /** 元の振り返りから抽出した条件文 */
  rule: string;
  category: string;
  /** 同じパターンで何回負けたか */
  occurrences: number;
  totalLoss: number;
  firstSeen: string;
  lastSeen: string;
  /** active = 判断時に適用される */
  active: boolean;
}

const LESSONS_FILE = "lessons-active";

/** 似たルール文を 60 文字 prefix でクラスタ化して集約 */
export async function rebuildLessonsFromReflections(): Promise<Lesson[]> {
  const reflections = await getReflections(200);
  const clusters: Record<string, { rule: string; reflections: LossReflection[]; category: string }> = {};

  for (const r of reflections) {
    const key = r.preventionRule.slice(0, 60).trim();
    if (!key) continue;
    if (!clusters[key]) {
      clusters[key] = { rule: r.preventionRule, reflections: [], category: r.category };
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
      // 30日以上ぶりは inactive
      const recentEnough = ageDays < 30;
      // 3 回以上発生 + 直近 30日以内 → active
      const active = c.reflections.length >= 3 && recentEnough;
      return {
        id: `lesson-${Buffer.from(key).toString("base64").slice(0, 12)}`,
        rule: c.rule,
        category: c.category,
        occurrences: c.reflections.length,
        totalLoss,
        firstSeen,
        lastSeen,
        active,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences);

  // active 上限 10 個
  let activeCount = 0;
  for (const l of lessons) {
    if (l.active && activeCount >= 10) {
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

/**
 * AI に「現在の状況がルールに該当するか」を判定させる軽量ヘルパー。
 * パフォーマンス考慮で AI 呼出しはせず、文字列マッチで近似する MVP。
 *
 * 高度版: 後で AI でコンテキスト評価に置き換え可能。
 */
export interface LessonCheckContext {
  action: "BUY" | "SELL" | "HOLD";
  pair: string;
  regime: string;
  fearGreed: number;
  rsi?: number;
  composite: number;
  confidence: number;
}

/** 単純文字列マッチでルール照合 (将来 AI 置換可) */
export function matchLessons(ctx: LessonCheckContext, lessons: Lesson[]): {
  blocked: boolean;
  matched: { rule: string; reason: string }[];
} {
  const matched: { rule: string; reason: string }[] = [];
  const text = ctx.action.toUpperCase();
  for (const l of lessons) {
    if (!l.active) continue;
    const rule = l.rule.toUpperCase();
    // 雑だが効く: ルール文に含まれるキーワードと現状を突き合わせる
    if (!rule.includes(text)) continue; // BUY 用ルールに SELL は無関係

    // 例: ルール = "RSI > 70 + 過去5本 +3% 急騰時 BUY 見送り"
    // 現状 RSI 73, 直近 +4% なら match
    let hit = false;
    if (ctx.rsi != null) {
      const rsiMatch = l.rule.match(/RSI\s*[><]\s*(\d+)/i);
      if (rsiMatch) {
        const threshold = Number(rsiMatch[1]);
        const op = l.rule.includes(">") ? ">" : "<";
        if (op === ">" && ctx.rsi > threshold) hit = true;
        if (op === "<" && ctx.rsi < threshold) hit = true;
      }
    }
    const fgMatch = l.rule.match(/F&G\s*[><]\s*(\d+)/i);
    if (fgMatch) {
      const threshold = Number(fgMatch[1]);
      const op = l.rule.includes(">") ? ">" : "<";
      if (op === ">" && ctx.fearGreed > threshold) hit = true;
      if (op === "<" && ctx.fearGreed < threshold) hit = true;
    }
    if (l.rule.toUpperCase().includes(ctx.regime.toUpperCase())) hit = true;

    if (hit) {
      matched.push({
        rule: l.rule,
        reason: `過去 ${l.occurrences} 回同じパターンで合計 ¥${Math.round(l.totalLoss)} の損失`,
      });
    }
  }

  // 2 件以上マッチ → block
  return { blocked: matched.length >= 2, matched };
}
