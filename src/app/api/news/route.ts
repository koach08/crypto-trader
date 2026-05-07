import { NextResponse } from "next/server";

interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  body?: string;
  categories?: string[];
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function parseRSS(xml: string, source: string, limit = 8): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const description = extractTag(block, "description") ?? extractTag(block, "content:encoded");
    const categoryMatches = [...block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)];

    if (!title || !link) continue;

    const cleanTitle = decodeEntities(stripCdata(title));
    const cleanUrl = decodeEntities(stripCdata(link));
    const cleanBody = description
      ? decodeEntities(stripCdata(description))
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)
      : undefined;

    let publishedAt = new Date().toISOString();
    if (pubDate) {
      const d = new Date(stripCdata(pubDate));
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const categories = categoryMatches
      .map((m) => decodeEntities(stripCdata(m[1])))
      .filter(Boolean)
      .slice(0, 3);

    items.push({
      title: cleanTitle,
      url: cleanUrl,
      source,
      publishedAt,
      body: cleanBody,
      categories: categories.length > 0 ? categories : undefined,
    });
  }
  return items;
}

async function fetchRSS(url: string, source: string, limit = 8): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 crypto-trader" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml, source, limit);
  } catch {
    return [];
  }
}

export async function GET() {
  const [coindesk, cointelegraph, bitcoinNews, trending, fng] = await Promise.all([
    fetchRSS("https://www.coindesk.com/arc/outboundfeeds/rss", "CoinDesk", 6),
    fetchRSS("https://cointelegraph.com/rss", "CoinTelegraph", 6),
    fetchRSS("https://news.bitcoin.com/feed/", "Bitcoin.com", 4),
    fetch("https://api.coingecko.com/api/v3/search/trending", {
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 600 },
    })
      .then(async (r) => {
        if (!r.ok) return [] as NewsItem[];
        const data = await r.json();
        return ((data?.coins || []) as Array<{ item: { name: string; symbol: string; market_cap_rank: number } }>)
          .slice(0, 5)
          .map((c) => ({
            title: `Trending: ${c.item.name} (${c.item.symbol}) - Rank #${c.item.market_cap_rank}`,
            url: `https://www.coingecko.com/en/coins/${c.item.name.toLowerCase().replace(/\s+/g, "-")}`,
            source: "CoinGecko Trending",
            publishedAt: new Date().toISOString(),
            categories: ["trending"],
          })) as NewsItem[];
      })
      .catch(() => [] as NewsItem[]),
    fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 3600 },
    })
      .then(async (r) => {
        if (!r.ok) return [] as NewsItem[];
        const data = await r.json();
        const fngData = data?.data?.[0];
        if (!fngData) return [] as NewsItem[];
        return [
          {
            title: `Fear & Greed Index: ${fngData.value} (${fngData.value_classification})`,
            url: "https://alternative.me/crypto/fear-and-greed-index/",
            source: "Alternative.me",
            publishedAt: new Date(Number(fngData.timestamp) * 1000).toISOString(),
            categories: ["sentiment"],
          },
        ] as NewsItem[];
      })
      .catch(() => [] as NewsItem[]),
  ]);

  const articles = [...fng, ...trending, ...coindesk, ...cointelegraph, ...bitcoinNews]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  return NextResponse.json({ articles, sources: { coindesk: coindesk.length, cointelegraph: cointelegraph.length, bitcoinNews: bitcoinNews.length, trending: trending.length, fng: fng.length } });
}
