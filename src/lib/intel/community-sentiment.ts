/**
 * コミュニティ sentiment 取得.
 *
 * Reddit JSON API (認証不要、無料、rate limit あり) を使う.
 * r/CryptoCurrency, r/bitcoin の top post を取得し、タイトルから sentiment 抽出.
 *
 * 限界:
 *  - 英語コミュニティのみ
 *  - キーワードベースで簡易判定
 *  - より精緻にするなら Twitter/X API (有料) や Discord scraping (規約注意)
 */

interface CommunitySignal {
  /** -100 (panic) 〜 +100 (euphoria) */
  score: number;
  /** 集計に使った投稿数 */
  postCount: number;
  /** 上位 posts のタイトル */
  topPosts: { title: string; ups: number; sentiment: "bullish" | "bearish" | "neutral" }[];
  available: boolean;
}

const SUBREDDITS = ["CryptoCurrency", "Bitcoin", "ethereum"];

// 簡易 sentiment 辞書 (英語、crypto コンテキスト)
const BULLISH_WORDS = [
  "rally", "moon", "surge", "pump", "bull", "buy", "long", "rocket",
  "ath", "all-time high", "breakout", "accumulating", "hold", "hodl",
  "diamond hands", "to the moon", "lambo", "etf approved", "adoption",
];

const BEARISH_WORDS = [
  "crash", "dump", "rug", "scam", "hack", "sell", "short", "bear",
  "panic", "fud", "regulation", "ban", "lawsuit", "exploit",
  "liquidation", "rekt", "collapse", "down", "drop", "fear",
];

interface RedditPost {
  data: {
    title: string;
    ups: number;
    selftext: string;
    created_utc: number;
  };
}

interface RedditResponse {
  data: { children: RedditPost[] };
}

function classifySentiment(title: string): "bullish" | "bearish" | "neutral" {
  const lower = title.toLowerCase();
  let bullScore = 0;
  let bearScore = 0;
  for (const w of BULLISH_WORDS) if (lower.includes(w)) bullScore++;
  for (const w of BEARISH_WORDS) if (lower.includes(w)) bearScore++;
  if (bullScore > bearScore) return "bullish";
  if (bearScore > bullScore) return "bearish";
  return "neutral";
}

async function fetchSubreddit(name: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${name}/hot.json?limit=25`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "crypto-trader-bot/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data: RedditResponse = await res.json();
    return data?.data?.children ?? [];
  } catch {
    return [];
  }
}

export async function getCommunitySentiment(): Promise<CommunitySignal> {
  const all: RedditPost[] = [];
  for (const sub of SUBREDDITS) {
    const posts = await fetchSubreddit(sub);
    all.push(...posts);
  }

  if (all.length === 0) {
    return { score: 0, postCount: 0, topPosts: [], available: false };
  }

  // 重み付き集計: ups (upvote 数) で重要度
  let weightedScore = 0;
  let totalWeight = 0;
  const tagged = all.map(p => {
    const sentiment = classifySentiment(p.data.title);
    const ups = p.data.ups || 1;
    const value = sentiment === "bullish" ? 1 : sentiment === "bearish" ? -1 : 0;
    weightedScore += value * ups;
    totalWeight += ups;
    return { title: p.data.title, ups, sentiment };
  });

  const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const score = Math.round(avgScore * 100);

  const topPosts = tagged
    .sort((a, b) => b.ups - a.ups)
    .slice(0, 5);

  return {
    score: Math.max(-100, Math.min(100, score)),
    postCount: all.length,
    topPosts,
    available: true,
  };
}
