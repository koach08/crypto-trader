/**
 * On-chain whale 動き追跡.
 * 大口ウォレットの取引所入金 = 売り兆候 (sell pressure).
 * 取引所出金 = 蓄積 (accumulation).
 *
 * データ源: Etherscan API (無料 5 calls/sec) or 同等の public RPC.
 */

interface WhaleSignal {
  /** -100 (強い売り兆候) 〜 +100 (強い買い/蓄積兆候) */
  score: number;
  /** 検出内容 */
  details: string[];
  /** データ取れたか */
  available: boolean;
}

// Etherscan V2 (V1 は deprecated). chainid 必須, API key 必須.
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const CHAIN_ID_ETH_MAINNET = 1;

// 主要 CEX の hot wallet (ETH 上、よく知られたもの)
// (簡略化、本来は本格的な whale DB が必要)
const KNOWN_CEX_WALLETS: Record<string, string> = {
  "Binance hot 1": "0x28C6c06298d514Db089934071355E5743bf21d60",
  "Binance hot 2": "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549",
  "Coinbase 1": "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
  "Bitfinex hot": "0x1151314c646Ce4E0eFD76d1aF4760aE66a9Fe30F",
};

interface EtherscanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
}

/** 特定 wallet の最新 N トランザクションから flow 判定 */
async function fetchWalletFlow(address: string, apiKey: string): Promise<{ inflows: number; outflows: number; netInflow: number; error?: string }> {
  // V2 endpoint: https://api.etherscan.io/v2/api?chainid=1&module=...
  const url = `${ETHERSCAN_API}?chainid=${CHAIN_ID_ETH_MAINNET}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=20&sort=desc&apikey=${apiKey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { inflows: 0, outflows: 0, netInflow: 0, error: `http-${res.status}` };
    const data = await res.json();
    // V2 でも status "1" = OK, "0" = error/no-result
    if (data.status !== "1") {
      const msg = String(data.message ?? data.result ?? "unknown");
      // "No transactions found" は正常 (新規 wallet 等) なのでエラー扱いしない
      if (/no transactions found/i.test(msg)) return { inflows: 0, outflows: 0, netInflow: 0 };
      return { inflows: 0, outflows: 0, netInflow: 0, error: msg.slice(0, 80) };
    }
    const txs = data.result as EtherscanTx[];

    let inflows = 0;
    let outflows = 0;
    const now = Date.now() / 1000;
    const dayAgo = now - 24 * 3600;

    for (const tx of txs) {
      const ts = Number(tx.timeStamp);
      if (ts < dayAgo) continue;
      const valueEth = Number(tx.value) / 1e18;
      if (tx.to.toLowerCase() === address.toLowerCase()) {
        inflows += valueEth;
      } else if (tx.from.toLowerCase() === address.toLowerCase()) {
        outflows += valueEth;
      }
    }
    return { inflows, outflows, netInflow: inflows - outflows };
  } catch (e) {
    return { inflows: 0, outflows: 0, netInflow: 0, error: e instanceof Error ? e.message.slice(0, 80) : "fetch failed" };
  }
}

/**
 * CEX 流入/流出の集計から市場の sentiment 推定.
 * 大量に CEX に入る = 売る準備 = bearish
 * CEX から出ていく = 寒い場所 (cold wallet) へ = accumulation = bullish
 */
export async function getWhaleSignal(): Promise<WhaleSignal> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) {
    return { score: 0, details: ["ETHERSCAN_API_KEY 未設定 (V2 API は key 必須)"], available: false };
  }

  const details: string[] = [];
  let totalNetInflow = 0;
  let walletsChecked = 0;
  const errors: string[] = [];

  for (const [name, addr] of Object.entries(KNOWN_CEX_WALLETS)) {
    const flow = await fetchWalletFlow(addr, key);
    if (flow.error) {
      errors.push(`${name}: ${flow.error}`);
      continue;
    }
    walletsChecked++;
    totalNetInflow += flow.netInflow;
    if (Math.abs(flow.netInflow) > 100) {
      const sign = flow.netInflow > 0 ? "流入" : "流出";
      details.push(`${name}: 24h ${sign} ${Math.abs(flow.netInflow).toFixed(0)} ETH`);
    }
  }

  if (walletsChecked === 0) {
    return { score: 0, details: ["whale data 取得失敗", ...errors.slice(0, 2)], available: false };
  }

  // 正規化: 1000 ETH 流入で score -50、流出で +50
  let score = -Math.max(-100, Math.min(100, (totalNetInflow / 1000) * 50));

  // 解釈: net inflow 正 = bearish (取引所に売りに来てる)、負 = bullish
  if (Math.abs(totalNetInflow) < 50) {
    details.unshift("ニュートラル (大口動き小)");
  } else if (totalNetInflow > 0) {
    details.unshift(`売り兆候: CEX に純流入 ${totalNetInflow.toFixed(0)} ETH`);
  } else {
    details.unshift(`蓄積兆候: CEX から純流出 ${Math.abs(totalNetInflow).toFixed(0)} ETH`);
  }

  return { score: Math.round(score), details, available: true };
}
