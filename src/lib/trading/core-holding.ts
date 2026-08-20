/**
 * コア保有 (売らない長期枠)。
 *
 * 【なぜ必要か】2026-08-19 の実測。
 * 日足トレンドゲート (trend-gate.ts) を入れた結果、BTC/ETH/XRP の 3 ペア全てが
 * `buyAllowed=false` となり、残高 ¥63,015 が**全額 JPY のまま**動かなくなった。
 * これは設計どおりの待機であって不具合ではない。ただし bitFlyer に置いた JPY は
 * 銀行に出金しない限り生活資金として使えるわけでもなく、「上昇トレンドが来るまで
 * 何ヶ月でも遊ばせる」のは本人の資金用途と噛み合っていない。
 *
 * そこで資金を 2 つに分ける。
 *   - コア枠   : 目標比率まで暗号資産で持ち続ける。売らない。トレンドゲートの対象外。
 *   - 戦術枠   : 従来どおり MA ルール (ENTRY_MODE=trend) が売買する。
 *
 * コア枠は「上がるまで待つ」のではなく「上がる時に持っていなかった」を防ぐための枠なので、
 * SL も TP も置かない。代わりに一括で入れず分割して積む (下降局面での一括投入を避ける)。
 *
 * ⚠️ これは勝ちを保証する仕組みではない。下落局面ではそのまま含み損になる。
 *    バックテストで確認できているのは「現行の逆張りより確実にマシ」までであって、
 *    コア保有そのものの期待値を検証したわけではない。ドローダウンは受け入れる前提の枠。
 */

export interface CoreHoldConfig {
  enabled: boolean;
  /** 総資産 (JPY + 暗号資産評価額) に対するコア枠の目標比率 0-1 */
  targetPct: number;
  /** ペアごとの比重。合計 1 に正規化して使う */
  weights: Record<string, number>;
  /** 目標額を何回に分けて積むか */
  tranches: number;
  /** トランシェ間の最小間隔 (時間)。同じペアを連続で買わないための間隔 */
  intervalHours: number;
  /** これ未満の発注はしない (取引所の最小注文とは別に、手数料負けを避ける下限) */
  minTrancheJPY: number;
  /**
   * 利確。ペアの含み益率がこれを超えたら一部だけ売って現金に戻す。0 で無効。
   * コア枠は本来「売らない」枠だが、現金のまま置くと何も起きないという理由で
   * 積んでいる以上、利益が出た分を確定させる出口が要る。
   */
  takeProfitPct: number;
  /** 利確で売る割合 (そのペアのコア保有数量に対して) */
  takeProfitFraction: number;
  /** 利確後、売値からこの率だけ下がるまで買い戻さない (売った直後に同値で買い直さないため) */
  reentryDiscountPct: number;
}

export interface CoreLot {
  at: string;
  pair: string;
  amountBase: number;
  priceJPY: number;
  costJPY: number;
}

export interface CoreHoldingState {
  lots: CoreLot[];
  /** pair → 直近の買付時刻 (ISO) */
  lastBuyAt: Record<string, string>;
  /** pair → 直近の利確売値。ここから reentryDiscountPct 下がるまで買い戻さない */
  lastSellPrice?: Record<string, number>;
  /** 利確で確定させた損益の累計 (JPY) */
  realizedJPY?: number;
}

export const EMPTY_CORE_STATE: CoreHoldingState = { lots: [], lastBuyAt: {}, lastSellPrice: {}, realizedJPY: 0 };

/** 既定の比重。長期で持ち切る枠なので時価総額上位 2 つに絞る。XRP は戦術枠のみ。 */
const DEFAULT_WEIGHTS: Record<string, number> = { "BTC/JPY": 0.6, "ETH/JPY": 0.4 };

function parseWeights(raw: string | undefined): Record<string, number> {
  if (!raw) return { ...DEFAULT_WEIGHTS };
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const [pair, w] = part.split(":").map((s) => s.trim());
    const num = Number(w);
    if (pair && Number.isFinite(num) && num > 0) out[pair] = num;
  }
  return Object.keys(out).length > 0 ? out : { ...DEFAULT_WEIGHTS };
}

export type CoreEnv = Record<string, string | undefined>;

export function loadCoreConfig(env: CoreEnv = process.env): CoreHoldConfig {
  const pct = Number(env.CORE_HOLD_PCT ?? "0.7");
  return {
    // 実弾が動くので既定は OFF。Railway 側で明示的に true にして初めて積み始める。
    enabled: env.CORE_HOLD_ENABLED === "true",
    targetPct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 0.95) : 0.7,
    weights: parseWeights(env.CORE_HOLD_WEIGHTS),
    tranches: Math.max(1, Number(env.CORE_HOLD_TRANCHES ?? "4")),
    intervalHours: Math.max(0, Number(env.CORE_HOLD_INTERVAL_HOURS ?? "24")),
    minTrancheJPY: Math.max(0, Number(env.CORE_HOLD_MIN_JPY ?? "3000")),
    takeProfitPct: Math.max(0, Number(env.CORE_TAKE_PROFIT_PCT ?? "0.2")),
    takeProfitFraction: Math.min(Math.max(Number(env.CORE_TAKE_PROFIT_FRACTION ?? "0.25"), 0), 1),
    reentryDiscountPct: Math.max(0, Number(env.CORE_REENTRY_DISCOUNT_PCT ?? "0.05")),
  };
}

/** コアとして確保している数量。売却経路はこの分を必ず残す。 */
export function coreAmount(state: CoreHoldingState, pair: string): number {
  return state.lots
    .filter((l) => l.pair === pair)
    .reduce((s, l) => s + l.amountBase, 0);
}

export function coreCostJPY(state: CoreHoldingState, pair: string): number {
  return state.lots
    .filter((l) => l.pair === pair)
    .reduce((s, l) => s + l.costJPY, 0);
}

/** 正規化した比重。設定に無いペアは 0。 */
export function normalizedWeights(cfg: CoreHoldConfig): Record<string, number> {
  const total = Object.values(cfg.weights).reduce((s, w) => s + w, 0);
  if (total <= 0) return {};
  const out: Record<string, number> = {};
  for (const [pair, w] of Object.entries(cfg.weights)) out[pair] = w / total;
  return out;
}

export function computeCoreTargetsJPY(navJPY: number, cfg: CoreHoldConfig): Record<string, number> {
  const weights = normalizedWeights(cfg);
  const budget = Math.max(0, navJPY) * cfg.targetPct;
  const out: Record<string, number> = {};
  for (const [pair, w] of Object.entries(weights)) out[pair] = budget * w;
  return out;
}

export interface CoreBuyPlan {
  pair: string;
  amountJPY: number;
  targetJPY: number;
  currentJPY: number;
  shortfallJPY: number;
  reason: string;
}

export interface CoreSkip {
  reason: string;
  /** 参考情報。画面に「なぜ買っていないか」を出すために使う */
  detail?: Record<string, number | string>;
}

export interface PlanCoreBuyInput {
  navJPY: number;
  jpyFree: number;
  cfg: CoreHoldConfig;
  state: CoreHoldingState;
  /** pair → 現在値 */
  prices: Record<string, number>;
  /** pair → 取引所が受け付ける最小注文 JPY (bitFlyer は BTC 0.001 = 約 ¥11,000) */
  minOrderJPY: Record<string, number>;
  nowMs: number;
}

/**
 * 次に積むべき 1 件を返す。1 サイクルにつき最大 1 件しか出さない
 * (同じサイクルで複数ペアに連続発注して現金を一気に使い切らないため)。
 *
 * 選び方は「目標に対する充足率が最も低いペア」。金額ではなく率で見るので、
 * 比重どおりに揃っていく。
 */
export function planCoreBuy(input: PlanCoreBuyInput): { plan: CoreBuyPlan | null; skip: CoreSkip | null } {
  const { navJPY, jpyFree, cfg, state, prices, minOrderJPY, nowMs } = input;

  if (!cfg.enabled) return { plan: null, skip: { reason: "コア保有は無効 (CORE_HOLD_ENABLED != true)" } };
  if (cfg.targetPct <= 0) return { plan: null, skip: { reason: "目標比率が 0" } };
  if (navJPY <= 0) return { plan: null, skip: { reason: "総資産を評価できない" } };

  const rawTargets = computeCoreTargetsJPY(navJPY, cfg);

  // 【端数の再配分】bitFlyer の BTC は 0.001 刻み (≒ ¥11,000) なので、
  // 目標額が最小注文の整数倍から外れると端数が永久に埋まらない。
  // 例: 目標 ¥26,516 → ¥11,265 × 2 = ¥22,530 まで積んだ後、残り ¥3,986 は
  // 最小注文未満で発注できず、「70% 指定なのに 64% で止まる」ことになる。
  // 刻めない端数は他のペアの目標に回して、指定した比率まで積み切れるようにする。
  const targets: Record<string, number> = { ...rawTargets };
  const stuck: string[] = [];
  const receivers: string[] = [];
  for (const [pair, targetJPY] of Object.entries(rawTargets)) {
    const price = prices[pair];
    if (!price || price <= 0) continue;
    const remaining = targetJPY - coreAmount(state, pair) * price;
    const minOrder = Math.max(minOrderJPY[pair] ?? 0, cfg.minTrancheJPY);
    // 「端数」と呼べるのは 1 トランシェ未満まで。ここを minOrder だけで判定すると、
    // 目標が最小注文の 2 倍程度しかないペア (BTC 目標 ¥22,930 / 最小 ¥11,639) で
    // 1 回積んだ直後の残り ¥11,323 まで「刻めない端数」に化け、目標のほぼ半分が
    // 他ペアに流れて比重が逆転する (BTC 0.6 / ETH 0.4 のはずが 3:7 になる)。
    // コアは売らない枠なので、一度流れた分は元に戻せない。
    // 残りが 1 トランシェを超えるうちは待つ。目標は NAV に連動して動くので、
    // NAV が 1-2% 増えるか価格が下がれば最小注文に届いて再開する。
    const crumb = remaining <= targetJPY / Math.max(1, cfg.tranches);
    if (remaining > targetJPY * 0.05 && remaining < minOrder && crumb) stuck.push(pair);
    else if (remaining >= minOrder) receivers.push(pair);
  }
  if (stuck.length > 0 && receivers.length > 0) {
    let spill = 0;
    for (const pair of stuck) {
      const price = prices[pair];
      spill += targets[pair] - coreAmount(state, pair) * price;
      targets[pair] = coreAmount(state, pair) * price; // これ以上は刻めない = 到達扱い
    }
    const share = spill / receivers.length;
    for (const pair of receivers) targets[pair] += share;
  }

  const candidates: Array<CoreBuyPlan & { fillRatio: number }> = [];

  for (const [pair, targetJPY] of Object.entries(targets)) {
    const price = prices[pair];
    if (!price || price <= 0) continue;

    const currentJPY = coreAmount(state, pair) * price;
    const shortfallJPY = targetJPY - currentJPY;
    // 5% の許容幅。価格変動のたびに端数を買い足さない。
    if (shortfallJPY <= targetJPY * 0.05) continue;

    // 利確した直後に同じ値段で買い戻さない。売値から reentryDiscountPct 下がるまで待つ。
    // これが無いと「+20% で売って次のサイクルで買い直す」を繰り返し、
    // 往復のスプレッドと手数料だけ払って数量が減っていく。
    const soldAt = state.lastSellPrice?.[pair];
    if (soldAt && soldAt > 0 && cfg.reentryDiscountPct > 0) {
      if (price > soldAt * (1 - cfg.reentryDiscountPct)) continue;
    }

    const last = state.lastBuyAt[pair];
    if (last && cfg.intervalHours > 0) {
      const elapsedH = (nowMs - Date.parse(last)) / 3_600_000;
      if (Number.isFinite(elapsedH) && elapsedH < cfg.intervalHours) continue;
    }

    // トランシェ額。取引所の最小注文を下回るなら最小注文まで引き上げる
    // (BTC は 0.001 単位 = 約 ¥11,000 なので、4 分割だと 1 回では発注できない)。
    const minOrder = minOrderJPY[pair] ?? 0;
    let amountJPY = Math.max(targetJPY / cfg.tranches, minOrder, cfg.minTrancheJPY);
    // 目標を超えて買わない。ただし最小注文を割るなら見送り。
    amountJPY = Math.min(amountJPY, shortfallJPY);
    if (amountJPY < Math.max(minOrder, cfg.minTrancheJPY)) continue;
    if (amountJPY > jpyFree) continue;

    candidates.push({
      pair,
      amountJPY: Math.floor(amountJPY),
      targetJPY,
      currentJPY,
      shortfallJPY,
      fillRatio: targetJPY > 0 ? currentJPY / targetJPY : 1,
      reason: `[コア積立] 目標 ¥${Math.round(targetJPY).toLocaleString()} に対し現在 ¥${Math.round(currentJPY).toLocaleString()}`,
    });
  }

  if (candidates.length === 0) {
    const totalTarget = Object.values(targets).reduce((s, v) => s + v, 0);
    const totalCurrent = Object.entries(targets).reduce(
      (s, [pair]) => s + coreAmount(state, pair) * (prices[pair] ?? 0),
      0
    );
    const filled = totalTarget > 0 && totalCurrent >= totalTarget * 0.95;
    return {
      plan: null,
      skip: {
        reason: filled ? "コア目標に到達済み" : "今サイクルで積める候補なし (間隔待ち / 現金不足 / 最小注文未満)",
        detail: { 目標JPY: Math.round(totalTarget), 現在JPY: Math.round(totalCurrent), 現金JPY: Math.round(jpyFree) },
      },
    };
  }

  candidates.sort((a, b) => a.fillRatio - b.fillRatio);
  const { fillRatio: _fillRatio, ...plan } = candidates[0];
  return { plan, skip: null };
}

export function applyCoreFill(
  state: CoreHoldingState,
  fill: { pair: string; amountBase: number; priceJPY: number; costJPY: number; at: string }
): CoreHoldingState {
  return {
    ...state,
    lots: [...state.lots, { ...fill }],
    lastBuyAt: { ...state.lastBuyAt, [fill.pair]: fill.at },
  };
}

export interface CoreTakeProfitPlan {
  pair: string;
  amountBase: number;
  priceJPY: number;
  proceedsJPY: number;
  avgCostJPY: number;
  gainPercent: number;
  reason: string;
}

/**
 * 利確できるペアを 1 件返す。
 *
 * 【なぜコア枠に出口を付けるか】この枠は「現金のまま置いても何も起きない」という
 * 理由で積んでいる。値上がりしても一度も売らなければ、増えたのは含み益だけで
 * 現金にはならない。上がったところで一部だけ現金に戻し、押したところで買い直す。
 *
 * 【何を守るか】売るのは常に一部 (takeProfitFraction) だけで、枠ごと畳むことはしない。
 * 判断はコア台帳の取得原価に対してのみ行い、戦術枠の SL/TP とは独立している。
 * 戦術枠から見た売却可能数量 (sellableAmount) は従来どおりコアを引いたままなので、
 * 「戦術枠の損切りがコアを巻き込む」経路は塞がれたまま。
 */
export function planCoreTakeProfit(input: {
  state: CoreHoldingState;
  cfg: CoreHoldConfig;
  prices: Record<string, number>;
  minOrderJPY: Record<string, number>;
}): { plan: CoreTakeProfitPlan | null; skip: CoreSkip | null } {
  const { state, cfg, prices, minOrderJPY } = input;
  if (!cfg.enabled) return { plan: null, skip: { reason: "コア保有は無効" } };
  if (cfg.takeProfitPct <= 0 || cfg.takeProfitFraction <= 0) {
    return { plan: null, skip: { reason: "コア利確は無効 (takeProfitPct = 0)" } };
  }

  const candidates: CoreTakeProfitPlan[] = [];
  for (const pair of new Set(state.lots.map((l) => l.pair))) {
    const price = prices[pair];
    if (!price || price <= 0) continue;
    const amount = coreAmount(state, pair);
    const cost = coreCostJPY(state, pair);
    if (amount <= 0 || cost <= 0) continue;

    const avgCost = cost / amount;
    const gain = (price - avgCost) / avgCost;
    if (gain < cfg.takeProfitPct) continue;

    const sellAmount = amount * cfg.takeProfitFraction;
    const proceeds = sellAmount * price;
    const minOrder = Math.max(minOrderJPY[pair] ?? 0, cfg.minTrancheJPY);
    // 最小注文に届かないなら見送る。刻めない量を投げても約定しない。
    if (proceeds < minOrder) continue;

    candidates.push({
      pair,
      amountBase: sellAmount,
      priceJPY: price,
      proceedsJPY: proceeds,
      avgCostJPY: avgCost,
      gainPercent: gain * 100,
      reason: `[コア利確] 取得平均 ¥${Math.round(avgCost).toLocaleString()} に対し ¥${Math.round(price).toLocaleString()} (+${(gain * 100).toFixed(1)}%)`,
    });
  }

  if (candidates.length === 0) return { plan: null, skip: { reason: "利確条件に届いているペアなし" } };
  // 利が乗っている順。1 サイクル 1 件だけ。
  candidates.sort((a, b) => b.gainPercent - a.gainPercent);
  return { plan: candidates[0], skip: null };
}

/**
 * 利確の約定を台帳に反映する。古いロットから減らす (FIFO)。
 * 確定した損益を realizedJPY に積み、売値を lastSellPrice に残して買い戻し価格の基準にする。
 */
export function applyCoreSell(
  state: CoreHoldingState,
  pair: string,
  amountBase: number,
  priceJPY: number
): { state: CoreHoldingState; realizedJPY: number } {
  let remaining = amountBase;
  let costRemoved = 0;
  const lots: CoreLot[] = [];

  for (const lot of state.lots) {
    if (lot.pair !== pair || remaining <= 0) {
      lots.push(lot);
      continue;
    }
    if (lot.amountBase <= remaining) {
      remaining -= lot.amountBase;
      costRemoved += lot.costJPY;
      continue; // ロットごと消える
    }
    const ratio = remaining / lot.amountBase;
    costRemoved += lot.costJPY * ratio;
    lots.push({
      ...lot,
      amountBase: lot.amountBase - remaining,
      costJPY: lot.costJPY * (1 - ratio),
    });
    remaining = 0;
  }

  const sold = amountBase - remaining;
  const realized = sold * priceJPY - costRemoved;
  return {
    state: {
      ...state,
      lots,
      lastSellPrice: { ...(state.lastSellPrice ?? {}), [pair]: priceJPY },
      realizedJPY: (state.realizedJPY ?? 0) + realized,
    },
    realizedJPY: realized,
  };
}

/**
 * 売却可能数量。取引所の実残高からコア確保分を引く。
 *
 * 【重要】ここを通さずに `realPosition.free` をそのまま売ると、コア枠ごと投げ売る。
 * 過去に「判断ロジックだけ直して発注経路が素通り」を踏んでいるので、
 * 売却系は全てこの関数を経由させること。
 */
export function sellableAmount(state: CoreHoldingState, pair: string, exchangeFree: number): number {
  return Math.max(0, exchangeFree - coreAmount(state, pair));
}

export interface CoreSummaryRow {
  pair: string;
  amountBase: number;
  costJPY: number;
  valueJPY: number;
  targetJPY: number;
  fillPercent: number;
  unrealizedPnLJPY: number;
  unrealizedPnLPercent: number;
}

export function summarizeCore(
  state: CoreHoldingState,
  cfg: CoreHoldConfig,
  navJPY: number,
  prices: Record<string, number>
): CoreSummaryRow[] {
  const targets = computeCoreTargetsJPY(navJPY, cfg);
  const pairs = new Set([...Object.keys(targets), ...state.lots.map((l) => l.pair)]);
  return Array.from(pairs).map((pair) => {
    const amountBase = coreAmount(state, pair);
    const costJPY = coreCostJPY(state, pair);
    const price = prices[pair] ?? 0;
    const valueJPY = amountBase * price;
    const targetJPY = targets[pair] ?? 0;
    const pnl = valueJPY > 0 ? valueJPY - costJPY : 0;
    return {
      pair,
      amountBase,
      costJPY,
      valueJPY,
      targetJPY,
      fillPercent: targetJPY > 0 ? Math.min(100, (valueJPY / targetJPY) * 100) : 0,
      unrealizedPnLJPY: pnl,
      unrealizedPnLPercent: costJPY > 0 ? (pnl / costJPY) * 100 : 0,
    };
  });
}

/**
 * 台帳を取引所の実残高に合わせる。
 *
 * 【なぜ必要か】コア台帳はアプリ側の記録でしかない。本人が bitFlyer の画面から
 * 直接売ってしまえば、台帳だけが残る。その状態を放置すると `sellableAmount` が
 * 「実残高 - 過大なコア」= 0 を返し続け、**そのペアが二度と売れなくなる**。
 * 実残高を上限として按分で切り詰めることで、取得原価の比率を保ったまま整合させる。
 */
export function clampCoreToBalance(
  state: CoreHoldingState,
  pair: string,
  exchangeTotal: number
): { state: CoreHoldingState; adjusted: boolean } {
  const held = coreAmount(state, pair);
  if (held <= exchangeTotal + 1e-12) return { state, adjusted: false };

  const ratio = held > 0 ? Math.max(0, exchangeTotal) / held : 0;
  const lots = state.lots
    .map((l) =>
      l.pair === pair
        ? { ...l, amountBase: l.amountBase * ratio, costJPY: l.costJPY * ratio }
        : l
    )
    .filter((l) => l.amountBase > 1e-12);
  return { state: { ...state, lots }, adjusted: true };
}

/**
 * 画面から変更した設定 (data/core-config.json) を env 既定に重ねる。
 *
 * Railway の環境変数をいじらないと比率も ON/OFF も変えられない状態は、
 * 本人が「今すぐ現金を止めたい / 増やしたい」と思ったときに操作できない。
 * 保存された値があればそちらを優先する。
 */
export type CoreConfigOverride = Partial<Pick<
  CoreHoldConfig,
  "enabled" | "targetPct" | "weights" | "tranches" | "intervalHours" | "minTrancheJPY"
  | "takeProfitPct" | "takeProfitFraction" | "reentryDiscountPct"
>>;

export function mergeCoreConfig(base: CoreHoldConfig, override: CoreConfigOverride | null | undefined): CoreHoldConfig {
  if (!override) return base;
  const merged: CoreHoldConfig = { ...base };
  if (typeof override.enabled === "boolean") merged.enabled = override.enabled;
  if (typeof override.targetPct === "number" && Number.isFinite(override.targetPct)) {
    merged.targetPct = Math.min(Math.max(override.targetPct, 0), 0.95);
  }
  if (override.weights && Object.keys(override.weights).length > 0) {
    const cleaned: Record<string, number> = {};
    for (const [pair, w] of Object.entries(override.weights)) {
      if (Number.isFinite(w) && w > 0) cleaned[pair] = w;
    }
    if (Object.keys(cleaned).length > 0) merged.weights = cleaned;
  }
  if (typeof override.tranches === "number" && override.tranches >= 1) merged.tranches = Math.floor(override.tranches);
  if (typeof override.intervalHours === "number" && override.intervalHours >= 0) merged.intervalHours = override.intervalHours;
  if (typeof override.minTrancheJPY === "number" && override.minTrancheJPY >= 0) merged.minTrancheJPY = override.minTrancheJPY;
  if (typeof override.takeProfitPct === "number" && override.takeProfitPct >= 0) merged.takeProfitPct = override.takeProfitPct;
  if (typeof override.takeProfitFraction === "number" && override.takeProfitFraction > 0 && override.takeProfitFraction <= 1) {
    merged.takeProfitFraction = override.takeProfitFraction;
  }
  if (typeof override.reentryDiscountPct === "number" && override.reentryDiscountPct >= 0) {
    merged.reentryDiscountPct = override.reentryDiscountPct;
  }
  return merged;
}

/**
 * 戦術枠だけの数量と取得平均を出す。
 *
 * 【なぜ要るか】取引所の約定履歴には戦術枠の売買もコア積立も同じように並ぶ。
 * 取引所側にどちらの枠かという情報は無いので、残高から FIFO 平均を取り直すと
 * **コアの買いが戦術ポジションに混ざる**。実際 XRP で
 * 「livePos.amount 60.83 ≠ realPosition 95.76 → 同期完了 95.76 @ ¥187.95」と
 * なり、コアの約31 XRP を戦術枠として抱えた状態でトレーリング SL が
 * 動いていた (売却自体は sellableFree が塞ぐが、SL/TP の基準値と
 * 実現損益の帰属が狂う)。
 *
 * コア台帳は数量も取得原価もこちらで持っているので、全体から差し引く。
 */
export function tacticalBasis(input: {
  /** 取引所の実残高 */
  exchangeAmount: number;
  /** 約定履歴から出した FIFO 平均取得単価 (コア込み) */
  fifoAvgPrice: number;
  /** コア台帳の数量 */
  coreAmountBase: number;
  /** コア台帳の取得原価合計 */
  coreCostJPY: number;
}): { amount: number; avgPrice: number } | null {
  const { exchangeAmount, fifoAvgPrice, coreAmountBase, coreCostJPY } = input;
  const amount = exchangeAmount - coreAmountBase;
  if (!(amount > 0) || !(fifoAvgPrice > 0)) return null;

  const tacticalCost = exchangeAmount * fifoAvgPrice - coreCostJPY;
  const avgPrice = tacticalCost / amount;
  // コアを高値で積んでいると差し引きが壊れることがある。その場合は
  // 全体平均のほうがまだ実態に近いので、そちらを使う。
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) return { amount, avgPrice: fifoAvgPrice };
  return { amount, avgPrice };
}
