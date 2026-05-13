import { NextResponse } from "next/server";
import { getReflections, getReflectionStats } from "@/lib/quant/reflection";
import { getAllLessons, getActiveLessons, rebuildLessonsFromReflections } from "@/lib/quant/lessons";

export async function GET() {
  const [reflections, stats, allLessons, activeLessons] = await Promise.all([
    getReflections(30),
    getReflectionStats(),
    getAllLessons(),
    getActiveLessons(),
  ]);
  return NextResponse.json({
    reflections,
    stats,
    allLessons,
    activeLessons,
  });
}

/** 手動で lessons を再構築 */
export async function POST() {
  const lessons = await rebuildLessonsFromReflections();
  return NextResponse.json({ ok: true, count: lessons.length, active: lessons.filter(l => l.active).length });
}
