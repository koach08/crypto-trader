import { NextResponse } from "next/server";
import { getFXState } from "@/lib/trading/fx-engine";

export async function GET() {
  const state = await getFXState();
  return NextResponse.json(state);
}
