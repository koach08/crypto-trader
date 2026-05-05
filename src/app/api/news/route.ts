import { NextResponse } from "next/server";

interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  body?: string;
  categories?: string[];
}

export async function GET() {
  try {
    const articles: NewsItem[] = [];

    // CryptoCompare News API (無料、APIキー不要)
    const ccResp = await fetch(
      "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular",
      { signal: AbortSignal.timeout(10000), next: { revalidate: 300 } }
    );
    if (ccResp.ok) {
      const ccData = await ccResp.json();
      const ccArticles = (ccData?.Data || []).slice(0, 15).map(
        (a: { title: string; url: string; source: string; published_on: number; body: string; categories: string }) => ({
          title: a.title,
          url: a.url,
          source: a.source,
          publishedAt: new Date(a.published_on * 1000).toISOString(),
          body: a.body?.slice(0, 200),
          categories: a.categories?.split("|").filter(Boolean),
        })
      );
      articles.push(...ccArticles);
    }

    // CoinGecko trending (市場動向)
    try {
      const trendResp = await fetch(
        "https://api.coingecko.com/api/v3/search/trending",
        { signal: AbortSignal.timeout(8000), next: { revalidate: 600 } }
      );
      if (trendResp.ok) {
        const trendData = await trendResp.json();
        const trendCoins = (trendData?.coins || []).slice(0, 5).map(
          (c: { item: { name: string; symbol: string; market_cap_rank: number; score: number } }) => ({
            title: `Trending: ${c.item.name} (${c.item.symbol}) - Rank #${c.item.market_cap_rank}`,
            url: `https://www.coingecko.com/en/coins/${c.item.name.toLowerCase().replace(/\s+/g, "-")}`,
            source: "CoinGecko Trending",
            publishedAt: new Date().toISOString(),
            categories: ["trending"],
          })
        );
        articles.push(...trendCoins);
      }
    } catch { /* CoinGecko rate limit is aggressive, skip if fails */ }

    // Fear & Greed Index
    try {
      const fngResp = await fetch(
        "https://api.alternative.me/fng/?limit=1",
        { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } }
      );
      if (fngResp.ok) {
        const fngData = await fngResp.json();
        const fng = fngData?.data?.[0];
        if (fng) {
          articles.push({
            title: `Fear & Greed Index: ${fng.value} (${fng.value_classification})`,
            url: "https://alternative.me/crypto/fear-and-greed-index/",
            source: "Alternative.me",
            publishedAt: new Date(Number(fng.timestamp) * 1000).toISOString(),
            categories: ["sentiment"],
          });
        }
      }
    } catch { /* skip */ }

    return NextResponse.json({ articles });
  } catch (e) {
    return NextResponse.json({ articles: [], error: String(e) }, { status: 500 });
  }
}
