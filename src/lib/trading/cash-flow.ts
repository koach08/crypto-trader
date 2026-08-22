/**
 * 入出金の台帳と、それを除いた成績。
 *
 * 【なぜ要るか】画面の「総資産推移」は入金でも増える。実際 ¥50,000 を入れた
 * 直後に 24h +73.73% と表示され、bot が稼いだように見えていた。
 * 総資産は総資産で知りたいので消さない。**入金を除いた成績を別に出す**。
 *
 * 考え方は単純にする。「いくら入れて、いま いくらあるか」。
 *   投入額 = 起点の資産 + その後の入金 - 出金
 *   損益   = 現在の総資産 - 投入額
 * 時間加重収益率のような指標もあるが、途中の入金タイミングで値が動くので、
 * 本人が確かめにくい。ここでは検算できる形を採る。
 */

export interface CashFlow {
  at: string;
  /** 入金は +、出金は -。JPY */
  amountJPY: number;
  note?: string;
  /** 自動検出か手入力か */
  source: "auto" | "manual";
}

export interface FundingReport {
  /** 計測の起点にした資産額 */
  baselineJPY: number;
  baselineAt: string | null;
  /** 起点以降の入金合計 */
  depositsJPY: number;
  /** 起点以降の出金合計 (正の数で返す) */
  withdrawalsJPY: number;
  /** 起点 + 入金 - 出金 */
  investedJPY: number;
  currentNavJPY: number;
  /** 現在資産 - 投入額 */
  profitJPY: number;
  profitPercent: number;
  flows: CashFlow[];
}

export function buildFundingReport(input: {
  baselineJPY: number;
  baselineAt: string | null;
  currentNavJPY: number;
  flows: CashFlow[];
}): FundingReport {
  const deposits = input.flows.filter((f) => f.amountJPY > 0).reduce((s, f) => s + f.amountJPY, 0);
  const withdrawals = input.flows.filter((f) => f.amountJPY < 0).reduce((s, f) => s - f.amountJPY, 0);
  const invested = input.baselineJPY + deposits - withdrawals;
  const profit = input.currentNavJPY - invested;
  return {
    baselineJPY: input.baselineJPY,
    baselineAt: input.baselineAt,
    depositsJPY: deposits,
    withdrawalsJPY: withdrawals,
    investedJPY: invested,
    currentNavJPY: input.currentNavJPY,
    profitJPY: profit,
    profitPercent: invested > 0 ? (profit / invested) * 100 : 0,
    flows: input.flows,
  };
}

/**
 * 外部入出金の自動検出。
 *
 * JPY 残高の変化のうち、その間の売買で説明できない分を外部の出入りとみなす。
 * ただし**しきい値を大きく取る**。売買代金と手数料の誤差で毎回拾うと台帳が
 * 汚れるし、誤検出した入金は「稼いでいない額を稼いだことにする」より
 * たちが悪い (逆に成績を良く見せる)。取りこぼしは手入力で足せる。
 */
export function detectCashFlow(input: {
  jpyBefore: number;
  jpyAfter: number;
  /** 区間中の売買による JPY 増減 (売り + / 買い -) */
  tradeNetJPY: number;
  /** これ未満の差は無視する */
  thresholdJPY?: number;
}): number | null {
  const threshold = input.thresholdJPY ?? 20_000;
  const unexplained = input.jpyAfter - input.jpyBefore - input.tradeNetJPY;
  if (Math.abs(unexplained) < threshold) return null;
  return unexplained;
}

/**
 * 暗号資産に投じた額に対する損益。**こちらが主指標**。
 *
 * 総資産は入金でも増えるので成績にならない。見たいのは「買った暗号資産が
 * いくらになったか」なので、購入代金を分母に取る。
 *
 *   損益 = 売却代金の合計 + 現在の評価額 - 購入代金の合計
 *
 * この式は確定と含みを分けずに足すので、途中で何度売買していても
 * 「入れた金に対していくら増えたか」がそのまま出る。検算もできる。
 */
export interface CryptoReturnReport {
  buyVolumeJPY: number;
  sellVolumeJPY: number;
  holdingsValueJPY: number;
  profitJPY: number;
  /** 購入代金に対する損益率 */
  profitPercent: number;
  /** 内訳: 決済済みの損益 */
  realizedJPY: number;
  /** 内訳: 現在保有分の含み損益 */
  unrealizedJPY: number;
}

export function buildCryptoReturn(input: {
  buyVolumeJPY: number;
  sellVolumeJPY: number;
  holdingsValueJPY: number;
  realizedJPY: number;
}): CryptoReturnReport {
  const profit = input.sellVolumeJPY + input.holdingsValueJPY - input.buyVolumeJPY;
  return {
    buyVolumeJPY: input.buyVolumeJPY,
    sellVolumeJPY: input.sellVolumeJPY,
    holdingsValueJPY: input.holdingsValueJPY,
    profitJPY: profit,
    profitPercent: input.buyVolumeJPY > 0 ? (profit / input.buyVolumeJPY) * 100 : 0,
    realizedJPY: input.realizedJPY,
    unrealizedJPY: profit - input.realizedJPY,
  };
}
