/**
 * Intel aggregator: 全 intel source を集約して bot の判断に活かす.
 *
 * 各 signal: -100 〜 +100
 * 重み付け平均で総合 sentiment 算出.
 */

import { getWhaleSignal } from "./whale-tracker";
import { getCommunitySentiment } from "./community-sentiment";
import { getFundingSignal } from "./funding-rate";

export interface AggregatedIntel {
  /** -100 (極端 bear) 〜 +100 (極端 bull) */
  totalScore: number;
  components: {
    whale: { score: number; details: string[]; available: boolean };
    community: { score: number; postCount: number; available: boolean };
    funding: { score: number; interpretation: string; available: boolean };
  };
  /** 解釈 */
  verdict: string;
  /** 動作中のソース数 (信頼度の指標) */
  sourcesAvailable: number;
}

// アプリ内キャッシュ (1 cycle = 5 min、長すぎず短すぎず 10 min cache)
let _cache: { data: AggregatedIntel; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function getAggregatedIntel(): Promise<AggregatedIntel> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const [whale, community, funding] = await Promise.all([
    getWhaleSignal().catch(() => ({ score: 0, details: ["whale fetch failed"], available: false })),
    getCommunitySentiment().catch(() => ({ score: 0, postCount: 0, topPosts: [] as { title: string; ups: number; sentiment: "bullish" | "bearish" | "neutral" }[], available: false })),
    getFundingSignal().catch(() => ({ score: 0, rates: {}, interpretation: "funding fetch failed", available: false })),
  ]);

  // 重み: whale 35%, funding 35%, community 30%
  // 各 source が available の時のみ加算、再正規化
  const weights = { whale: 0.35, funding: 0.35, community: 0.3 };
  let totalScore = 0;
  let totalWeight = 0;
  if (whale.available) {
    totalScore += whale.score * weights.whale;
    totalWeight += weights.whale;
  }
  if (funding.available) {
    totalScore += funding.score * weights.funding;
    totalWeight += weights.funding;
  }
  if (community.available) {
    totalScore += community.score * weights.community;
    totalWeight += weights.community;
  }

  const normalizedScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

  let verdict = "";
  if (normalizedScore >= 50) verdict = "強い bullish";
  else if (normalizedScore >= 20) verdict = "bullish 寄り";
  else if (normalizedScore > -20) verdict = "ニュートラル";
  else if (normalizedScore > -50) verdict = "bearish 寄り";
  else verdict = "強い bearish";

  const data: AggregatedIntel = {
    totalScore: normalizedScore,
    components: {
      whale: { score: whale.score, details: whale.details, available: whale.available },
      community: { score: community.score, postCount: community.postCount, available: community.available },
      funding: { score: funding.score, interpretation: funding.interpretation, available: funding.available },
    },
    verdict,
    sourcesAvailable: [whale.available, community.available, funding.available].filter(Boolean).length,
  };

  _cache = { data, fetchedAt: Date.now() };
  return data;
}
