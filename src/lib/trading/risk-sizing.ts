/**
 * 1 回のリスク量から建玉サイズを決める。
 *
 * 【なぜ要るか】これまで建玉は ¥15,000 固定で、損切り幅だけを 2% にしていた。
 * すると「損切りを広げる = リスクを増やす」という交換になり、
 * 「2% か 8% か」という選び方しかできなくなる。
 *
 * 順番が逆で、先に決めるべきは **1 回にいくら失ってよいか**。
 * 損切り幅はそこから逆算する。
 *
 *   建玉 = (総資産 × 1回のリスク割合) ÷ 損切り幅
 *
 * こうすると損切りを広げてもリスク量は変わらない。総資産が増減すれば
 * サイズも自動で追従する。1% は一般的な水準。
 */

export interface RiskSizingInput {
  /** 総資産 */
  navJPY: number;
  /** 1 回のリスク割合 (0.01 = 総資産の1%) */
  riskFraction: number;
  /** 損切り幅 (8 = 8%) */
  stopLossPercent: number;
  /** 発注に使える現金 */
  availableJPY: number;
  /** ペアあたりの上限 */
  maxJPY: number;
  /** 取引所の最小注文額 */
  minOrderJPY: number;
}

export interface RiskSizingResult {
  sizeJPY: number;
  /** この建玉で損切りに当たったときに失う額 */
  riskJPY: number;
  reason: string;
}

export function riskBudgetedSize(input: RiskSizingInput): RiskSizingResult {
  const { navJPY, riskFraction, stopLossPercent, availableJPY, maxJPY, minOrderJPY } = input;
  if (!(navJPY > 0) || !(riskFraction > 0) || !(stopLossPercent > 0)) {
    return { sizeJPY: 0, riskJPY: 0, reason: "入力不足でサイズを出せない" };
  }

  const budget = navJPY * riskFraction;
  const raw = budget / (stopLossPercent / 100);

  let size = Math.floor(Math.min(raw, maxJPY, availableJPY));
  const reasons: string[] = [];
  if (raw > maxJPY) reasons.push(`上限 ¥${Math.round(maxJPY).toLocaleString()} で頭打ち`);
  if (raw > availableJPY) reasons.push("現金不足で縮小");

  // 最小注文を割るなら見送る。無理に最小まで上げるとリスク割合を超える。
  if (size < minOrderJPY) {
    return {
      sizeJPY: 0,
      riskJPY: 0,
      reason: `最小注文 ¥${Math.round(minOrderJPY).toLocaleString()} に届かない (リスク上限では ¥${Math.round(raw).toLocaleString()})`,
    };
  }

  const riskJPY = size * (stopLossPercent / 100);
  return {
    sizeJPY: size,
    riskJPY,
    reason:
      `リスク ¥${Math.round(budget).toLocaleString()} (資産の${(riskFraction * 100).toFixed(1)}%) ÷ SL ${stopLossPercent}% = ¥${Math.round(raw).toLocaleString()}` +
      (reasons.length ? ` → ${reasons.join(" / ")}` : ""),
  };
}
