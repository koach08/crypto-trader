/**
 * BTC オンチェーン実需 signal: 「BTC が実際に動いてる量」.
 *
 * カード消費データの crypto 版. 投機 (Reddit, funding) ではなく、
 * 送金や決済としての本来の利用がどれだけ伸びてるか.
 *
 * データ源: mempool.space (無料 public API)
 *   - 1d 平均 tx 数 (ブロック内 tx 数)
 *   - 平均手数料 (混雑 = 需要)
 *   - mempool 詰まり (未確認 tx 数)
 *
 * スコア化:
 *   tx 数が直近 7d 平均より +20% → bullish (+40)
 *   平均手数料が直近 7d 平均より +50% → bullish (+30) ※需要急増
 *   mempool 詰まり (3MB 超) → bullish (+30) ※活発
 *   逆方向は対称的に bearish.
 */

interface MempoolBlock {
  id: string;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  /** sat */
  totalFees?: number;
  extras?: { totalFees?: number; medianFee?: number };
}

export interface OnchainSignal {
  /** -100 (decline) 〜 +100 (booming usage) */
  score: number;
  available: boolean;
  metrics: {
    /** 直近 24h の平均 tx/block */
    txPerBlockRecent: number;
    /** 過去 7d 平均 tx/block */
    txPerBlockBaseline: number;
    /** 直近 mempool 詰まり (vBytes) */
    mempoolVSize: number;
    /** 直近 fee 中央値 (sat/vB) */
    medianFee: number;
  };
  details: string[];
}

const MEMPOOL_BASE = "https://mempool.space/api";

const ZERO_METRICS = {
  txPerBlockRecent: 0,
  txPerBlockBaseline: 0,
  mempoolVSize: 0,
  medianFee: 0,
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * 過去 N ブロックの tx 数を平均化.
 * mempool.space の /v1/blocks エンドポイントで最近 15 blocks ずつ返る.
 * 144 blocks = 約 1 日, 1008 blocks = 約 7 日.
 *
 * 過去 7 日全部取ると重いので「直近 1d (144 blocks)」と「過去 7d ですが先頭から 7 chunk」で代用.
 */
export async function getOnchainSignal(): Promise<OnchainSignal> {
  const unavailable: OnchainSignal = {
    score: 0,
    available: false,
    metrics: { ...ZERO_METRICS },
    details: ["mempool.space 取得失敗"],
  };

  // 直近 ~144 blocks (24h相当) を 15 blocks ずつ取得
  // mempool.space /v1/blocks/{height} で startHeight 指定可
  const recentBlocks: MempoolBlock[] = [];
  type BlockWithHeight = MempoolBlock & { height?: number };
  const blocksUrl = (start?: number) => start === undefined ? `${MEMPOOL_BASE}/v1/blocks` : `${MEMPOOL_BASE}/v1/blocks/${start}`;
  let cursor: number | undefined = undefined;
  for (let i = 0; i < 10 && recentBlocks.length < 144; i++) {
    const batch: BlockWithHeight[] | null = await fetchJson<BlockWithHeight[]>(blocksUrl(cursor));
    if (!batch || batch.length === 0) break;
    recentBlocks.push(...batch);
    const lastHeight: number | undefined = batch[batch.length - 1].height;
    if (typeof lastHeight === "number" && lastHeight > 0) {
      cursor = lastHeight - 1;
    } else {
      break;
    }
  }

  if (recentBlocks.length === 0) return unavailable;

  // 直近 ~24h (取れた範囲) と 「同じデータの後半 = 古め」 を比較で代用.
  // 真の 7d 平均は取得コスト高いので、直近 N vs その手前 N で短期トレンドだけ見る.
  const half = Math.floor(recentBlocks.length / 2);
  const recent = recentBlocks.slice(0, half);
  const older = recentBlocks.slice(half);

  const avgTx = (blocks: MempoolBlock[]) => blocks.length > 0 ? blocks.reduce((s, b) => s + b.tx_count, 0) / blocks.length : 0;
  const txPerBlockRecent = avgTx(recent);
  const txPerBlockBaseline = avgTx(older);

  // mempool 状況
  const mempool = await fetchJson<{ count: number; vsize: number; total_fee: number }>(`${MEMPOOL_BASE}/mempool`);
  const mempoolVSize = mempool?.vsize ?? 0;

  // 手数料
  const fees = await fetchJson<{ fastestFee: number; halfHourFee: number; hourFee: number }>(`${MEMPOOL_BASE}/v1/fees/recommended`);
  const medianFee = fees?.halfHourFee ?? 0;

  // スコア
  let score = 0;
  const details: string[] = [];
  if (txPerBlockBaseline > 0) {
    const change = (txPerBlockRecent - txPerBlockBaseline) / txPerBlockBaseline;
    const txScore = Math.max(-40, Math.min(40, change * 200)); // ±20%→±40pt
    score += txScore;
    details.push(`tx/block ${txPerBlockRecent.toFixed(0)} vs ${txPerBlockBaseline.toFixed(0)} (${(change * 100).toFixed(1)}%)`);
  }

  // mempool 詰まり: 3 MB (3000000 vbytes) 超で +30, 100 KB 未満で -20 (閑散)
  if (mempoolVSize > 3_000_000) {
    score += 30;
    details.push(`mempool 詰まり ${(mempoolVSize / 1_000_000).toFixed(1)}MB (混雑=実需高)`);
  } else if (mempoolVSize > 0 && mempoolVSize < 100_000) {
    score -= 20;
    details.push(`mempool 閑散 ${(mempoolVSize / 1000).toFixed(0)}KB`);
  }

  // 手数料: 50 sat/vB 超 = 高需要 +20, 5 未満 = 閑散 -10
  if (medianFee > 50) {
    score += 20;
    details.push(`手数料高騰 ${medianFee} sat/vB`);
  } else if (medianFee > 0 && medianFee < 5) {
    score -= 10;
    details.push(`手数料低水準 ${medianFee} sat/vB`);
  }

  score = Math.max(-100, Math.min(100, Math.round(score)));

  return {
    score,
    available: true,
    metrics: { txPerBlockRecent, txPerBlockBaseline, mempoolVSize, medianFee },
    details,
  };
}
