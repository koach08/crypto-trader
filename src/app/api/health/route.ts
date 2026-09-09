import { NextResponse } from "next/server";
import { BUILD_INFO } from "@/lib/build-info";

export async function GET() {
  // build は「今どのコードが本番に乗っているか」。push しただけで動いていると
  // 仮定しないための目印 (scripts/stamp-build.sh で焼き込む)。
  return NextResponse.json({ ok: true, timestamp: Date.now(), build: BUILD_INFO });
}
