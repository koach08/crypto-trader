/**
 * 永続先物 (perpetual futures) の funding rate 取得.
 * 高い正 funding = ロング偏り (反転リスク、売り兆候)
 * 高い負 funding = ショート偏り (反発期待、買い兆候、squeeze)
 *
 * データ源: Binance public API (無料、認証不要)
 */

interface FundingSignal {
  /** -100 (極端なショート偏り = 反発期待) 〜 +100 (極端なロング偏り = 反転リスク) */
  score: number;
  /** ペア別 funding rate (%) */
  rates: Record<string, number>;
  /** 解釈 */
  interpretation: string;
  available: boolean;
}

const BINANCE_FUTURES_API = "https://fapi.binance.com";

// crypto-trader が見るペアを Binance の表記に変換
const PAIR_MAP: Record<string, string> = {
  "BTC/JPY": "BTCUSDT",
  "ETH/JPY": "ETHUSDT",
  "XRP/JPY": "XRPUSDT",
  "XLM/JPY": "XLMUSDT",
};

async function fetchFundingRate(symbol: string): Promise<number | null> {
  try {
    const url = `${BINANCE_FUTURES_API}/fapi/v1/premiumIndex?symbol=${symbol}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    // lastFundingRate は小数 (例: 0.0001 = 0.01%)
    return Number(data.lastFundingRate ?? 0) * 100;
  } catch {
    return null;
  }
}

export async function getFundingSignal(): Promise<FundingSignal> {
  const rates: Record<string, number> = {};
  const symbols = Object.values(PAIR_MAP);

  await Promise.all(
    symbols.map(async (sym) => {
      const rate = await fetchFundingRate(sym);
      if (rate !== null) rates[sym] = rate;
    })
  );

  if (Object.keys(rates).length === 0) {
    return { score: 0, rates: {}, interpretation: "funding data 取得失敗", available: false };
  }

  // 平均 funding rate (%)
  const avg = Object.values(rates).reduce((s, r) => s + r, 0) / Object.values(rates).length;

  // 正規化: ±0.05% で ±50、±0.1% で ±100 のスコア
  // funding 正 (ロング偏り) → ベア・スコア (- score), 負 (ショート偏り) → ブル・スコア (+ score)
  const score = -Math.max(-100, Math.min(100, (avg / 0.05) * 50));

  let interpretation = "";
  if (Math.abs(avg) < 0.005) interpretation = `funding ニュートラル (${avg.toFixed(4)}%)`;
  else if (avg > 0.02) interpretation = `ロング過熱 (${avg.toFixed(4)}%) → 反転リスク`;
  else if (avg > 0.005) interpretation = `ロング優勢 (${avg.toFixed(4)}%)`;
  else if (avg < -0.02) interpretation = `ショート過熱 (${avg.toFixed(4)}%) → 反発期待`;
  else interpretation = `ショート優勢 (${avg.toFixed(4)}%)`;

  return {
    score: Math.round(score),
    rates,
    interpretation,
    available: true,
  };
}
