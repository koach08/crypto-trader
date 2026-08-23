/**
 * 手数料を円に直す。
 *
 * 【なぜ要るか】bitFlyer は約定手数料を**基軸通貨建て**で返す。XRP を売れば
 * XRP、BTC を買えば BTC で来る。それを円として足していたため、
 * 売買代金 ¥2,750,000 に対して記録された手数料が **¥0.19** になっていた。
 * 実際には 0.1% 前後を払っている。回転数の多い仕組みでは、この取りこぼしが
 * そのまま「勝っているように見える」誤差になる。
 */

/**
 * 通貨が分からない手数料は**そのまま円として扱う**。
 * 基軸通貨と決めつけて掛け算すると、値がおかしいときに損益を大きく壊す
 * (BTC なら 1200万倍になる)。bitFlyer 側は feeCurrency を必ず入れるので、
 * 実データは正しく換算される。古い保管分は取り直しで上書きされる。
 */
export function feeToJPY(input: {
  fee: number;
  feeCurrency?: string;
  pair: string;
  /** その約定の単価 */
  priceJPY: number;
}): number {
  const { fee, feeCurrency, pair, priceJPY } = input;
  if (!Number.isFinite(fee) || fee === 0) return 0;

  const quote = pair.split("/")[1] ?? "JPY";
  const base = pair.split("/")[0] ?? "";
  if (!feeCurrency) return fee;
  const cur = feeCurrency.toUpperCase();

  // 円建てで来ているならそのまま
  if (cur === quote.toUpperCase()) return fee;
  // 基軸通貨建て → 約定単価で円に直す
  if (cur === base.toUpperCase()) {
    if (!(priceJPY > 0)) return 0;
    return fee * priceJPY;
  }
  // 知らない通貨は 0 にする。誤った換算で数字を作るより、計上しないほうがまし
  return 0;
}
