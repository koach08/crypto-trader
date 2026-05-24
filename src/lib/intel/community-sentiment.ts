/**
 * コミュニティ sentiment 取得.
 *
 * 旧 Reddit 直接スクレイプは datacenter IP (Railway/AWS/GCP) からは
 * 一律 http-403 で block されるため使用不可.
 *
 * 代替ソース (両方 datacenter IP 制限なし):
 *   1. alternative.me Fear & Greed Index (社会的 sentiment の代表)
 *      - F&G 0-100 を -100〜+100 にマッピング (50=中立、極度恐怖=底値圏=bullish 反転狙い)
 *      - 既存 engine とは「逆張り」の見方: 極度恐怖=-100 ではなく逆に +50 寄与 (歴史的に底)
 *   2. Hacker News Algolia API (crypto 関連 story の量と質)
 *      - 過去 24h の crypto post 数と points 合計
 *      - 「話題沸騰」= attention 急増 = 短期的に上下どちらにせよボラ高
 */

interface CommunitySignal {
  /** -100 〜 +100 */
  score: number;
  /** 集計に使った posts 数 (HN 由来) */
  postCount: number;
  /** 上位 posts のタイトル */
  topPosts: { title: string; ups: number; sentiment: "bullish" | "bearish" | "neutral" }[];
  available: boolean;
  errors?: string[];
}

const FNG_API = "https://api.alternative.me/fng/";
const HN_API = "https://hn.algolia.com/api/v1/search_by_date";

interface FngEntry { value: string; value_classification: string; timestamp: string }
interface FngResponse { data?: FngEntry[] }

interface HnHit {
  title?: string;
  points?: number;
  created_at_i?: number;
  num_comments?: number;
}
interface HnResponse { hits?: HnHit[] }

const BULLISH_WORDS = [
  "rally", "surge", "pump", "bull", "rocket", "ath", "breakout", "adoption",
  "etf approved", "halving", "moon", "buy", "long", "accumulating", "rebound",
];
const BEARISH_WORDS = [
  "crash", "dump", "rug", "scam", "hack", "ban", "lawsuit", "collapse",
  "exploit", "rekt", "fud", "panic", "regulation", "outflow", "selloff",
];

function classifySentiment(title: string): "bullish" | "bearish" | "neutral" {
  const lower = title.toLowerCase();
  let b = 0, s = 0;
  for (const w of BULLISH_WORDS) if (lower.includes(w)) b++;
  for (const w of BEARISH_WORDS) if (lower.includes(w)) s++;
  if (b > s) return "bullish";
  if (s > b) return "bearish";
  return "neutral";
}

async function fetchFng(): Promise<{ score: number; latest: number; trend7d: number; available: boolean; error?: string }> {
  try {
    const res = await fetch(`${FNG_API}?limit=8`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { score: 0, latest: 0, trend7d: 0, available: false, error: `fng http-${res.status}` };
    const data = (await res.json()) as FngResponse;
    const arr = data.data ?? [];
    if (arr.length === 0) return { score: 0, latest: 0, trend7d: 0, available: false, error: "fng empty" };
    const latest = Number(arr[0].value);
    const weekAgo = Number(arr[Math.min(arr.length - 1, 7)].value);
    // 逆張りビュー: 極度恐怖 (≤25) = 反転狙い +、極度貪欲 (≥75) = bearish 警戒 -
    // F&G 50 を 0 にして両側に振る (係数 -2 で逆方向)
    let score = -(latest - 50) * 1.5; // 0→+75, 100→-75
    // トレンド: 上昇 (恐怖→貪欲) は短期 bullish 寄与 (中立に向かう自然な流れ)
    const trend = latest - weekAgo;
    score += trend * 0.5; // ±20 の変動で ±10pt
    return {
      score: Math.max(-100, Math.min(100, Math.round(score))),
      latest, trend7d: trend, available: true,
    };
  } catch (e) {
    return { score: 0, latest: 0, trend7d: 0, available: false, error: e instanceof Error ? e.message.slice(0, 80) : "fng fetch failed" };
  }
}

async function fetchHnCrypto(): Promise<{ score: number; postCount: number; topPosts: { title: string; ups: number; sentiment: "bullish" | "bearish" | "neutral" }[]; available: boolean; error?: string }> {
  try {
    // 過去 24h の crypto 関連 story
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const url = `${HN_API}?query=bitcoin+OR+ethereum+OR+crypto&tags=story&numericFilters=created_at_i>${oneDayAgo}&hitsPerPage=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { score: 0, postCount: 0, topPosts: [], available: false, error: `hn http-${res.status}` };
    const data = (await res.json()) as HnResponse;
    const hits = data.hits ?? [];
    if (hits.length === 0) return { score: 0, postCount: 0, topPosts: [], available: true };

    let weighted = 0;
    let totalWeight = 0;
    const tagged = hits
      .filter(h => typeof h.title === "string")
      .map(h => {
        const sent = classifySentiment(h.title!);
        const w = Math.max(1, h.points ?? 1);
        weighted += (sent === "bullish" ? 1 : sent === "bearish" ? -1 : 0) * w;
        totalWeight += w;
        return { title: h.title!, ups: h.points ?? 0, sentiment: sent };
      });

    const sentimentScore = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;
    const topPosts = tagged.sort((a, b) => b.ups - a.ups).slice(0, 5);
    return {
      score: Math.max(-100, Math.min(100, sentimentScore)),
      postCount: hits.length,
      topPosts,
      available: true,
    };
  } catch (e) {
    return { score: 0, postCount: 0, topPosts: [], available: false, error: e instanceof Error ? e.message.slice(0, 80) : "hn fetch failed" };
  }
}

export async function getCommunitySentiment(): Promise<CommunitySignal> {
  const [fng, hn] = await Promise.all([fetchFng(), fetchHnCrypto()]);
  const errors: string[] = [];
  if (fng.error) errors.push(fng.error);
  if (hn.error) errors.push(hn.error);

  // F&G が main、HN が補助 (HN sentiment は keyword ベースで信頼度低め)
  // F&G 70%, HN 30%
  let score = 0;
  let totalWeight = 0;
  if (fng.available) { score += fng.score * 0.7; totalWeight += 0.7; }
  if (hn.available) { score += hn.score * 0.3; totalWeight += 0.3; }
  const finalScore = totalWeight > 0 ? Math.round(score / totalWeight) : 0;

  if (!fng.available && !hn.available) {
    console.warn(`[community-sentiment] 全ソース失敗: ${errors.join(" | ")}`);
    return { score: 0, postCount: 0, topPosts: [], available: false, errors };
  }
  if (errors.length > 0) {
    console.warn(`[community-sentiment] 一部失敗: ${errors.join(" | ")}`);
  }

  return {
    score: Math.max(-100, Math.min(100, finalScore)),
    postCount: hn.postCount,
    topPosts: hn.topPosts,
    available: true,
    errors: errors.length > 0 ? errors : undefined,
  };
}
