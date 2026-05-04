import { NextRequest, NextResponse } from "next/server";
import { loadData, saveData } from "@/lib/data";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const data = await loadData(key, null);
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { key, data } = await req.json();
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  await saveData(key, data);
  return NextResponse.json({ ok: true });
}
