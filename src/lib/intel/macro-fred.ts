/**
 * マクロ環境 signal: ドル指数 (DXY) と米 10 年金利.
 *
 * crypto は USD と逆相関:
 *   DXY 上昇 = ドル強い = リスク資産 (crypto) bearish
 *   米10年金利 上昇 = 安全資産魅力 up = リスク資産 bearish
 *
 * データ源: FRED API (https://api.stlouisfed.org/fred/series/observations)
 *   - DTWEXBGS: ドル広域指数 (DXY 相当, weekly)
 *   - DGS10: 米 10 年金利 (daily)
 *
 * 必要: FRED_API_KEY (無料、https://fred.stlouisfed.org/docs/api/api_key.html)
 *
 * スコア:
 *   DXY 1w 変化 +0.5% → bearish (-30)、-0.5% → bullish (+30)
 *   10Y 1w 変化 +20bp → bearish (-30)、-20bp → bullish (+30)
 *   2 指標を合算 (clamp ±100)
 */

export interface MacroSignal {
  score: number;
  available: boolean;
  metrics: {
    dxyLatest: number;
    dxyWeekAgo: number;
    dxyChangePercent: number;
    treasury10yLatest: number;
    treasury10yWeekAgo: number;
    treasury10yChangeBp: number;
  };
  details: string[];
}

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

interface FredObservation { date: string; value: string }
interface FredResponse { observations?: FredObservation[] }

const ZERO: MacroSignal["metrics"] = {
  dxyLatest: 0,
  dxyWeekAgo: 0,
  dxyChangePercent: 0,
  treasury10yLatest: 0,
  treasury10yWeekAgo: 0,
  treasury10yChangeBp: 0,
};

async function fetchSeries(seriesId: string, key: string, limit = 14): Promise<number[]> {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as FredResponse;
    if (!Array.isArray(data.observations)) return [];
    return data.observations
      .map(o => parseFloat(o.value))
      .filter(v => Number.isFinite(v));
  } catch {
    return [];
  }
}

export async function getMacroSignal(): Promise<MacroSignal> {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    return {
      score: 0,
      available: false,
      metrics: { ...ZERO },
      details: ["FRED_API_KEY 未設定"],
    };
  }

  const [dxySeries, t10Series] = await Promise.all([
    fetchSeries("DTWEXBGS", key, 14), // weekly, latest first
    fetchSeries("DGS10", key, 14),    // daily, latest first
  ]);

  if (dxySeries.length === 0 && t10Series.length === 0) {
    return {
      score: 0,
      available: false,
      metrics: { ...ZERO },
      details: ["FRED 取得失敗"],
    };
  }

  // DXY: weekly なので [0] = 直近、[1] = 1 週前
  const dxyLatest = dxySeries[0] ?? 0;
  const dxyWeekAgo = dxySeries[1] ?? dxyLatest;
  const dxyChangePercent = dxyWeekAgo > 0 ? ((dxyLatest - dxyWeekAgo) / dxyWeekAgo) * 100 : 0;

  // 10Y: daily なので [0] = 今日、[5-7] = 1 週前
  const t10Latest = t10Series[0] ?? 0;
  const t10WeekAgo = t10Series[6] ?? t10Series[t10Series.length - 1] ?? t10Latest;
  const t10ChangeBp = (t10Latest - t10WeekAgo) * 100; // % to bp

  // スコア (逆相関なので符号反転)
  let dxyScore = 0;
  if (dxyChangePercent !== 0) {
    dxyScore = Math.max(-30, Math.min(30, -dxyChangePercent * 60)); // ±0.5%→±30pt
  }
  let t10Score = 0;
  if (t10ChangeBp !== 0) {
    t10Score = Math.max(-30, Math.min(30, -t10ChangeBp * 1.5)); // ±20bp→±30pt
  }

  const score = Math.max(-100, Math.min(100, Math.round(dxyScore + t10Score)));

  const details: string[] = [];
  if (dxyLatest > 0) details.push(`DXY ${dxyLatest.toFixed(2)} (${dxyChangePercent >= 0 ? "+" : ""}${dxyChangePercent.toFixed(2)}% / 1w)`);
  if (t10Latest > 0) details.push(`US10Y ${t10Latest.toFixed(2)}% (${t10ChangeBp >= 0 ? "+" : ""}${t10ChangeBp.toFixed(0)}bp / 1w)`);
  details.push(`crypto は DXY/金利と逆相関 → スコア ${score > 0 ? "+" : ""}${score}`);

  return {
    score,
    available: true,
    metrics: {
      dxyLatest,
      dxyWeekAgo,
      dxyChangePercent,
      treasury10yLatest: t10Latest,
      treasury10yWeekAgo: t10WeekAgo,
      treasury10yChangeBp: t10ChangeBp,
    },
    details,
  };
}
