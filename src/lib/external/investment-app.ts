/**
 * investment-app (Vercel) のマルチソース分析を crypto-trader 判断に取り込む。
 *
 * 各 API は重め (AI 解析や外部 fetch 含む) なのでアプリ内キャッシュ必須。
 * サイクルごとに毎回叩くのではなく、TTL ベースで結果を再利用する。
 */

const BASE_URL = process.env.INVESTMENT_APP_URL ?? "https://investment-app-iota-nine.vercel.app";

interface CachedValue<T> {
  data: T;
  fetchedAt: number;
  ttlMs: number;
}

const cache = new Map<string, CachedValue<unknown>>();

async function cachedFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && (now - hit.fetchedAt) < hit.ttlMs) {
    return hit.data as T;
  }
  try {
    const data = await fetcher();
    cache.set(key, { data, fetchedAt: now, ttlMs });
    return data;
  } catch (e) {
    console.warn(`[investment-app] ${key} fetch failed:`, e instanceof Error ? e.message : e);
    // 直前のキャッシュがあれば期限切れでも返す (degraded service)
    if (hit) return hit.data as T;
    return null;
  }
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  category?: string;
}

export interface FedToneData {
  fed?: {
    hawkish_score: number;
    dovish_score: number;
    stance: "hawkish" | "neutral" | "dovish";
    rate_hike_probability: number;
    summary_ja?: string;
  };
  boj?: {
    hawkish_score: number;
    dovish_score: number;
    stance: "hawkish" | "neutral" | "dovish";
    summary_ja?: string;
  } | null;
  updated_at?: string;
}

export interface StocksFearGreedData {
  score: number; // 0-100
  rating: "extreme fear" | "fear" | "neutral" | "greed" | "extreme greed";
  timestamp?: string;
}

export interface EconomicEvent {
  date: string;
  event: string;
  importance?: "high" | "medium" | "low";
  country?: string;
}

async function http<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    signal: opts.signal ?? AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

/** 一般ニュース (30 分キャッシュ) */
export function fetchNews(): Promise<{ news: NewsItem[] } | null> {
  return cachedFetch("news", 30 * 60 * 1000, () => http<{ news: NewsItem[] }>("/api/news"));
}

/** FRB / BOJ 発言トーン (6 時間キャッシュ) */
export function fetchFedTone(): Promise<FedToneData | null> {
  return cachedFetch("fed-tone", 6 * 60 * 60 * 1000, () => http<FedToneData>("/api/fed-tone"));
}

/** 株式市場の F&G (1 時間キャッシュ) */
export function fetchStocksFearGreed(): Promise<StocksFearGreedData | null> {
  return cachedFetch("stocks-fg", 60 * 60 * 1000, () => http<StocksFearGreedData>("/api/fear-greed"));
}

/** 経済指標カレンダー (12 時間キャッシュ) */
export function fetchEconomicCalendar(): Promise<{ events: EconomicEvent[] } | null> {
  return cachedFetch("econ-cal", 12 * 60 * 60 * 1000, () => http<{ events: EconomicEvent[] }>("/api/economic-calendar"));
}

// =====================================================================
// 統合スコア: マルチソースから単一の bias を算出 (BUY 寄り +、SELL 寄り -)
// =====================================================================

export interface ExternalBias {
  /** -100 (強い SELL bias) 〜 +100 (強い BUY bias) */
  score: number;
  /** 各ソースの内訳と理由 */
  components: { name: string; score: number; reason: string }[];
  /** 投票に使うべきでない (重大イベント前後など) */
  pause: boolean;
  pauseReason?: string;
}

/** crypto bot の 1 サイクルから呼ぶ。全 API を並列 fetch + キャッシュ + bias 算出 */
export async function fetchExternalBias(cryptoKeywords: string[] = ["bitcoin", "btc", "ethereum", "eth", "crypto", "暗号"]): Promise<ExternalBias> {
  const [news, fedTone, stocksFG, econCal] = await Promise.all([
    fetchNews(),
    fetchFedTone(),
    fetchStocksFearGreed(),
    fetchEconomicCalendar(),
  ]);

  const components: ExternalBias["components"] = [];
  let totalScore = 0;
  let pause = false;
  let pauseReason: string | undefined;

  // 1. 株式 F&G (低スコア = 株市場全体の恐怖 = crypto も連動下落リスク)
  if (stocksFG) {
    const fg = stocksFG.score;
    let s = 0;
    let reason = "";
    if (fg <= 25) { s = 30; reason = `株式 F&G ${fg} 極度恐怖 = 反転狙い`; }
    else if (fg <= 40) { s = 10; reason = `株式 F&G ${fg} 恐怖 = やや BUY 寄り`; }
    else if (fg >= 75) { s = -30; reason = `株式 F&G ${fg} 極度貪欲 = 反転リスク`; }
    else if (fg >= 60) { s = -10; reason = `株式 F&G ${fg} 貪欲 = やや SELL 寄り`; }
    else { reason = `株式 F&G ${fg} 中立`; }
    components.push({ name: "株式F&G", score: s, reason });
    totalScore += s;
  }

  // 2. FRB トーン (hawkish = 利上げ警戒 = crypto 売り、dovish = 緩和 = crypto 買い)
  if (fedTone?.fed) {
    const f = fedTone.fed;
    let s = 0;
    let reason = "";
    if (f.stance === "hawkish") {
      s = -25;
      reason = `FRB hawkish (利上げ確率 ${(f.rate_hike_probability * 100).toFixed(0)}%) = リスクオフ`;
    } else if (f.stance === "dovish") {
      s = 25;
      reason = `FRB dovish (緩和姿勢) = リスクオン`;
    } else {
      reason = `FRB neutral`;
    }
    components.push({ name: "FRBトーン", score: s, reason });
    totalScore += s;
  }

  // 3. ニュースセンチメント (crypto キーワード含むニュースのタイトルから推定)
  if (news?.news) {
    const cryptoNews = news.news.filter(n =>
      cryptoKeywords.some(k => n.title.toLowerCase().includes(k.toLowerCase()))
    );
    if (cryptoNews.length > 0) {
      // 簡易センチメント: ネガティブワード/ポジティブワードカウント
      const negWords = ["crash", "fall", "drop", "plunge", "regulation", "ban", "hack", "暴落", "下落", "禁止", "規制"];
      const posWords = ["surge", "rally", "high", "gain", "etf", "approve", "adoption", "上昇", "急騰", "高値", "承認"];
      let neg = 0;
      let pos = 0;
      for (const n of cryptoNews) {
        const t = n.title.toLowerCase();
        for (const w of negWords) if (t.includes(w.toLowerCase())) neg++;
        for (const w of posWords) if (t.includes(w.toLowerCase())) pos++;
      }
      const net = pos - neg;
      const s = Math.max(-25, Math.min(25, net * 5));
      const reason = `crypto ニュース ${cryptoNews.length} 件中 pos ${pos} / neg ${neg}`;
      components.push({ name: "ニュース", score: s, reason });
      totalScore += s;
    } else {
      components.push({ name: "ニュース", score: 0, reason: "crypto 関連ニュースなし" });
    }
  }

  // 4. 経済指標重大イベント (FOMC, 雇用統計等が 6 時間以内 → 取引控える)
  if (econCal?.events) {
    const now = Date.now();
    const sixHourMs = 6 * 60 * 60 * 1000;
    const upcoming = econCal.events.filter(e => {
      const t = new Date(e.date).getTime();
      return t > now && t < now + sixHourMs && e.importance === "high";
    });
    if (upcoming.length > 0) {
      pause = true;
      pauseReason = `重要経済指標 ${upcoming.length} 件が 6h 以内 (${upcoming[0].event})`;
      components.push({ name: "経済イベント", score: 0, reason: pauseReason });
    }
  }

  return {
    score: Math.max(-100, Math.min(100, totalScore)),
    components,
    pause,
    pauseReason,
  };
}
