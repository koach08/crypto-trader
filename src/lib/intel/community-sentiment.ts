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
  /** 失敗時の理由 (UI 表示用) */
  errors?: string[];
}

// Reddit 推奨 UA 形式: <platform>:<app id>:<version> (by /u/<reddit user>)
// 環境変数 REDDIT_USER_AGENT で上書き可能 (cloud IP block 回避用)
const DEFAULT_UA = "node:crypto-trader:1.0 (by /u/koach08)";

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

async function fetchSubreddit(name: string, ua: string): Promise<{ posts: RedditPost[]; error?: string }> {
  // old.reddit.com の方が cloud IP block が緩い傾向
  const url = `https://old.reddit.com/r/${name}/hot.json?limit=25&raw_json=1`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { posts: [], error: `${name}: http-${res.status}` };
    const data: RedditResponse = await res.json();
    return { posts: data?.data?.children ?? [] };
  } catch (e) {
    return { posts: [], error: `${name}: ${e instanceof Error ? e.message.slice(0, 60) : "fetch failed"}` };
  }
}

export async function getCommunitySentiment(): Promise<CommunitySignal> {
  const ua = process.env.REDDIT_USER_AGENT || DEFAULT_UA;
  const all: RedditPost[] = [];
  const errors: string[] = [];
  for (const sub of SUBREDDITS) {
    const result = await fetchSubreddit(sub, ua);
    if (result.error) errors.push(result.error);
    all.push(...result.posts);
    // rate limit 回避 (Reddit 60 req/min)
    await new Promise(r => setTimeout(r, 1100));
  }

  if (all.length === 0) {
    console.warn(`[community-sentiment] 全 subreddit 失敗: ${errors.join(" | ")}`);
    return { score: 0, postCount: 0, topPosts: [], available: false, errors };
  }
  if (errors.length > 0) {
    console.warn(`[community-sentiment] 一部失敗 (取得 ${all.length} posts): ${errors.join(" | ")}`);
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
    errors: errors.length > 0 ? errors : undefined,
  };
}
