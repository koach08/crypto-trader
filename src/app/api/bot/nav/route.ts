import { NextResponse } from "next/server";
import { loadData } from "@/lib/data";

interface NavSnapshot {
  timestamp: string;
  jpy: number;
  cryptoValueJPY: number;
  total: number;
  positions: Record<string, { amount: number; price: number; valueJPY: number }>;
}

interface NavDelta {
  total: number;
  percent: number;
  fromTimestamp: string;
}

interface NavResponse {
  current: NavSnapshot | null;
  first: NavSnapshot | null;
  delta24h: NavDelta | null;
  delta7d: NavDelta | null;
  delta30d: NavDelta | null;
  deltaLifetime: NavDelta | null;
  history: { timestamp: string; total: number; jpy: number; cryptoValueJPY: number }[];
}

function pickClosest(history: NavSnapshot[], targetMs: number): NavSnapshot | null {
  let best: NavSnapshot | null = null;
  let bestDiff = Infinity;
  for (const s of history) {
    const t = new Date(s.timestamp).getTime();
    const diff = Math.abs(t - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

function makeDelta(current: NavSnapshot, base: NavSnapshot | null): NavDelta | null {
  if (!base) return null;
  const total = current.total - base.total;
  const percent = base.total > 0 ? (total / base.total) * 100 : 0;
  return { total, percent, fromTimestamp: base.timestamp };
}

export async function GET() {
  const history = await loadData<NavSnapshot[]>("nav-history", []);
  if (history.length === 0) {
    return NextResponse.json({
      current: null,
      first: null,
      delta24h: null,
      delta7d: null,
      delta30d: null,
      deltaLifetime: null,
      history: [],
    } as NavResponse);
  }

  const current = history[history.length - 1];
  const first = history[0];
  const now = Date.now();

  const base24h = pickClosest(history, now - 24 * 60 * 60 * 1000);
  const base7d = pickClosest(history, now - 7 * 24 * 60 * 60 * 1000);
  const base30d = pickClosest(history, now - 30 * 24 * 60 * 60 * 1000);

  // base が現在と同じスナップショットなら無効化（履歴が浅い場合）
  const validBase = (b: NavSnapshot | null) =>
    b && b.timestamp !== current.timestamp ? b : null;

  const response: NavResponse = {
    current,
    first,
    delta24h: makeDelta(current, validBase(base24h)),
    delta7d: makeDelta(current, validBase(base7d)),
    delta30d: makeDelta(current, validBase(base30d)),
    deltaLifetime: first.timestamp !== current.timestamp ? makeDelta(current, first) : null,
    // チャート用に間引き（最新200点まで）
    history: history.slice(-200).map((s) => ({
      timestamp: s.timestamp,
      total: s.total,
      jpy: s.jpy,
      cryptoValueJPY: s.cryptoValueJPY,
    })),
  };

  return NextResponse.json(response);
}
