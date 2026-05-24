/**
 * Intel aggregator: 全 intel source を集約して bot の判断に活かす.
 *
 * カテゴリ:
 *   1. 投機系: whale, funding, community  (短期需給)
 *   2. 実需系: onchain, stablecoin, lightning, tvl  (中長期 utility)
 *   3. マクロ系: FRED DXY + 10Y 金利  (外部環境)
 *
 * 各 signal: -100 〜 +100
 * カテゴリ単位で平均 → カテゴリ間も重み付け平均
 */

import { getWhaleSignal } from "./whale-tracker";
import { getCommunitySentiment } from "./community-sentiment";
import { getFundingSignal } from "./funding-rate";
import { getOnchainSignal } from "./utility-onchain";
import { getStablecoinSignal } from "./utility-stablecoin";
import { getLightningSignal } from "./utility-lightning";
import { getTvlSignal } from "./utility-tvl";
import { getMacroSignal } from "./macro-fred";

export interface AggregatedIntel {
  /** -100 (極端 bear) 〜 +100 (極端 bull) */
  totalScore: number;
  components: {
    // 投機系
    whale: { score: number; details: string[]; available: boolean };
    community: { score: number; postCount: number; available: boolean };
    funding: { score: number; interpretation: string; available: boolean };
    // 実需系
    onchain: { score: number; details: string[]; available: boolean };
    stablecoin: { score: number; details: string[]; available: boolean };
    lightning: { score: number; details: string[]; available: boolean };
    tvl: { score: number; details: string[]; available: boolean };
    // マクロ系
    macro: { score: number; details: string[]; available: boolean };
  };
  /** カテゴリ別の集約スコア */
  categories: {
    speculation: { score: number; available: boolean };
    utility: { score: number; available: boolean };
    macro: { score: number; available: boolean };
  };
  /** 解釈 */
  verdict: string;
  /** 動作中のソース数 (信頼度の指標) */
  sourcesAvailable: number;
}

let _cache: { data: AggregatedIntel; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

// カテゴリ内の重み
const SPEC_WEIGHTS = { whale: 0.4, funding: 0.35, community: 0.25 };
const UTIL_WEIGHTS = { onchain: 0.3, stablecoin: 0.3, lightning: 0.15, tvl: 0.25 };
// カテゴリ間の重み: 実需 35% + 投機 35% + マクロ 30% (バランス重視)
const CATEGORY_WEIGHTS = { speculation: 0.35, utility: 0.35, macro: 0.30 };

function weightedAvg(items: Array<{ score: number; weight: number; available: boolean }>): { score: number; available: boolean } {
  let s = 0;
  let w = 0;
  let any = false;
  for (const it of items) {
    if (!it.available) continue;
    s += it.score * it.weight;
    w += it.weight;
    any = true;
  }
  return { score: w > 0 ? s / w : 0, available: any };
}

export async function getAggregatedIntel(): Promise<AggregatedIntel> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const [whale, community, funding, onchain, stablecoin, lightning, tvl, macro] = await Promise.all([
    getWhaleSignal().catch(() => ({ score: 0, details: ["whale fetch failed"], available: false })),
    getCommunitySentiment().catch(() => ({ score: 0, postCount: 0, topPosts: [] as { title: string; ups: number; sentiment: "bullish" | "bearish" | "neutral" }[], available: false })),
    getFundingSignal().catch(() => ({ score: 0, rates: {}, interpretation: "funding fetch failed", available: false })),
    getOnchainSignal().catch(() => ({ score: 0, details: ["onchain fetch failed"], available: false, metrics: { txPerBlockRecent: 0, txPerBlockBaseline: 0, mempoolVSize: 0, medianFee: 0 } })),
    getStablecoinSignal().catch(() => ({ score: 0, details: ["stablecoin fetch failed"], available: false, metrics: { currentSupplyUSD: 0, weekAgoSupplyUSD: 0, changePercent7d: 0, breakdown: [] } })),
    getLightningSignal().catch(() => ({ score: 0, details: ["lightning fetch failed"], available: false, metrics: { nodeCount: 0, channelCount: 0, totalCapacitySat: 0, nodeChangePercent7d: 0, channelChangePercent7d: 0, capacityChangePercent7d: 0 } })),
    getTvlSignal().catch(() => ({ score: 0, details: ["tvl fetch failed"], available: false, metrics: { currentTvlUSD: 0, weekAgoTvlUSD: 0, changePercent7d: 0 } })),
    getMacroSignal().catch(() => ({ score: 0, details: ["macro fetch failed"], available: false, metrics: { dxyLatest: 0, dxyWeekAgo: 0, dxyChangePercent: 0, treasury10yLatest: 0, treasury10yWeekAgo: 0, treasury10yChangeBp: 0 } })),
  ]);

  // カテゴリ集約
  const speculation = weightedAvg([
    { score: whale.score, weight: SPEC_WEIGHTS.whale, available: whale.available },
    { score: funding.score, weight: SPEC_WEIGHTS.funding, available: funding.available },
    { score: community.score, weight: SPEC_WEIGHTS.community, available: community.available },
  ]);
  const utility = weightedAvg([
    { score: onchain.score, weight: UTIL_WEIGHTS.onchain, available: onchain.available },
    { score: stablecoin.score, weight: UTIL_WEIGHTS.stablecoin, available: stablecoin.available },
    { score: lightning.score, weight: UTIL_WEIGHTS.lightning, available: lightning.available },
    { score: tvl.score, weight: UTIL_WEIGHTS.tvl, available: tvl.available },
  ]);
  const macroCat = { score: macro.score, available: macro.available };

  // 全体合算
  const totalAgg = weightedAvg([
    { score: speculation.score, weight: CATEGORY_WEIGHTS.speculation, available: speculation.available },
    { score: utility.score, weight: CATEGORY_WEIGHTS.utility, available: utility.available },
    { score: macroCat.score, weight: CATEGORY_WEIGHTS.macro, available: macroCat.available },
  ]);
  const normalizedScore = Math.round(totalAgg.score);

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
      onchain: { score: onchain.score, details: onchain.details, available: onchain.available },
      stablecoin: { score: stablecoin.score, details: stablecoin.details, available: stablecoin.available },
      lightning: { score: lightning.score, details: lightning.details, available: lightning.available },
      tvl: { score: tvl.score, details: tvl.details, available: tvl.available },
      macro: { score: macro.score, details: macro.details, available: macro.available },
    },
    categories: {
      speculation: { score: Math.round(speculation.score), available: speculation.available },
      utility: { score: Math.round(utility.score), available: utility.available },
      macro: { score: Math.round(macroCat.score), available: macroCat.available },
    },
    verdict,
    sourcesAvailable: [
      whale.available, community.available, funding.available,
      onchain.available, stablecoin.available, lightning.available, tvl.available,
      macro.available,
    ].filter(Boolean).length,
  };

  _cache = { data, fetchedAt: Date.now() };
  return data;
}
