import { NextResponse } from "next/server";
import { getDCAState } from "@/lib/trading/dca";

export async function GET() {
  const state = await getDCAState();
  return NextResponse.json({
    state,
    config: {
      enabled: process.env.DCA_ENABLED === "1",
      amountPerPair: Number(process.env.DCA_AMOUNT_JPY_PER_PAIR ?? "3000"),
      dayOfWeek: Number(process.env.DCA_DAY_OF_WEEK ?? "1"),
      hourJST: Number(process.env.DCA_HOUR_JST ?? "9"),
    },
  });
}
