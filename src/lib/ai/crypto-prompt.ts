import type { TickerData, TechnicalSignal } from "../types";
import type { MultiTimeframeAnalysis } from "../quant/timeframe-analyzer";
import type { AutoGuardrails } from "../quant/auto-guardrails";

interface PromptParams {
  pair: string;
  ticker: TickerData;
  signal: TechnicalSignal;
  fearGreed: { value: number; label: string };
  position: { amount: number; free: number };
  balance: { currency: string; free: number }[];
  recentDecisions?: { action: string; confidence: number; reason: string; timestamp: string }[];
  paperMode?: boolean;
  mtf?: MultiTimeframeAnalysis | null;
  /** 直近の自動学習で抽出された自分の負けパターン (AI に自己認識させる) */
  autoGuardrails?: AutoGuardrails | null;
  /** 過去 N 日の自分の勝率 (loss=true なら 50% 未満) */
  performanceContext?: { winRate: number; closedTrades: number; netPnLJPY: number } | null;
}

// 塵ポジション閾値: これ未満は「実質ノーポジ」として BUY 余地を残す
// (¥500 未満は SELL 益が手数料負けで意味ない & 新規 BUY 機会を逃す)
const DUST_POSITION_JPY = 500;

export const CRYPTO_SYSTEM_PROMPT = `あなたは機関投資家グレードのデイトレード/スイング暗号通貨ストラテジストである。
忖度禁止、データドリブン、daily small win 優先で判断する。

## 判断ドクトリン
1. **複数指標が同方向なら積極的に売買発火** — テクニカル + クオンツ + センチメントの 3 つのうち 2 つ以上が同方向なら BUY/SELL を選択
2. **HOLD は判断材料がゼロの時のみ** — 直近 HOLD が 3 回以上連続している場合、わずかなシグナルでもエントリー方向に倒す
3. **塵ポジション無視** — 保有時価が ¥500 未満の場合は「実質ノーポジション」扱い。BUY 余地ありとして判断する
4. **フリップフロップ防止は『直近 2 サイクル以内の真逆方向』のみ** — それ以外は新規シグナルに従う
5. **Fear & Greed が極端 (<25 / >75) は逆張り好機** — 高確信度 (70+) で発火
6. **マルチタイムフレーム整合性を最重視** — 短期/中期/長期 view が揃う方向に倒す
7. **RSI N/A・データ不足を HOLD 理由にしない** — 他指標で判断
8. **リスクリワード 1:2 以上を維持** — TP/SL 比率は最低 2:1

## 出力
必ず以下の JSON 形式のみ (他のテキスト一切不要):
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reason": "判断理由を1-2文 (どの指標が決め手か明示)",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "suggested_stop_loss_percent": 数値,
  "suggested_take_profit_percent": 数値
}`;

export const CRYPTO_SYSTEM_PROMPT_PAPER = `あなたは仮想通貨デイトレード/スイングストラテジストである (ペーパートレード = 検証モード)。
本番版と同じ institutional-grade ドクトリンで判断するが、学習データを最大化するため積極性をやや高めに設定。

## 判断ドクトリン (本番と共通)
1. **複数指標が同方向なら積極的に売買発火** — テクニカル + クオンツ + センチメントの 2 つ以上が同方向で BUY/SELL
2. **HOLD は判断材料がゼロの時のみ** — 直近 HOLD が 3 回以上連続なら、わずかなシグナルでもエントリー方向に倒す
3. **塵ポジション無視** — 保有時価が ¥500 未満は実質ノーポジション扱い
4. **フリップフロップ防止は『直近 2 サイクル以内の真逆方向』のみ** — それ以外は新規シグナルに従う
5. **Fear & Greed が極端 (<25 / >75) は逆張り好機** — 高確信度で発火
6. **マルチタイムフレーム整合性を最重視** — 短期/中期/長期 view が揃う方向に倒す
7. **RSI N/A・データ不足を HOLD 理由にしない**
8. **リスクリワード 1:2 以上を維持** — TP/SL 比率は最低 2:1
9. **ペーパー特例**: 確信度 45 以上で発火可 (検証データ収集を優先)

## 出力
必ず以下の JSON 形式のみ (他のテキスト一切不要):
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reason": "判断理由を1-2文 (どの指標が決め手か明示)",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "suggested_stop_loss_percent": 数値,
  "suggested_take_profit_percent": 数値
}`;

export function buildAnalysisPrompt(params: PromptParams): string {
  const { pair, ticker, signal, fearGreed, position, balance, recentDecisions, paperMode, mtf, autoGuardrails, performanceContext } = params;
  const positionValueJPY = position.amount * ticker.price;
  const isDust = positionValueJPY > 0 && positionValueJPY < DUST_POSITION_JPY;
  const hasPosition = position.amount > 0 && !isDust;
  const jpyBalance = balance.find(b => b.currency === "JPY");

  let prompt = `以下のデータを分析し、${pair}の売買判断をしてください。${paperMode ? "\n※ペーパートレードモード — 積極的に判断してください。" : ""}

## テクニカル分析
- RSI(14): ${signal.rsi?.toFixed(1) ?? "N/A"}
- MACD Histogram: ${signal.macdHistogram?.toFixed(2) ?? "N/A"}
- ボリンジャーバンド: ${signal.bbPosition ?? "N/A"}
- ATR(14): ${signal.atr?.toFixed(0) ?? "N/A"}
- SMA20: ${signal.sma20?.toFixed(0) ?? "N/A"}
- SMA50: ${signal.sma50?.toFixed(0) ?? "N/A"}
- 出来高比率(vs 20期間平均): ${signal.volumeRatio?.toFixed(2) ?? "N/A"}
- テクニカルスコア: ${signal.score} / シグナル: ${signal.signal}

## 市場センチメント
Fear & Greed Index: ${fearGreed.value} (${fearGreed.label})`;

  // 自己パフォーマンス: AI に「自分が今どれだけ負けてるか」を認識させる
  if (performanceContext) {
    const pc = performanceContext;
    prompt += `

## 自分の直近パフォーマンス (重要 — 過去の失敗から学べ)
- 確定取引数: ${pc.closedTrades} 件
- 勝率: ${pc.winRate.toFixed(1)}% ${pc.winRate < 40 ? "(⚠️ 著しく低い — 判断質を上げる必要あり)" : pc.winRate < 50 ? "(目標未達 — エントリー基準を厳格化)" : "(目標達成方向)"}
- 純損益: ¥${Math.round(pc.netPnLJPY).toLocaleString()} ${pc.netPnLJPY < 0 ? "(マイナス — 高確信時ほど慎重に)" : "(プラス — 現戦略を継続)"}`;
  }

  // 自分の負けパターン: AI に自己認識させる (loss-analyzer の output)
  if (autoGuardrails && (autoGuardrails.highRiskPairs.length > 0 || autoGuardrails.highRiskRegimes.length > 0 || autoGuardrails.blockedHourRanges.length > 0)) {
    prompt += `

## 自分の負けパターン (損失データから自動抽出 — 同じ失敗を繰り返さないこと)`;
    if (autoGuardrails.highRiskPairs.includes(pair)) {
      prompt += `\n- ⚠️ ${pair} は損失集中ペア。エントリーは確信度 60% 以上 + 複数指標一致が必須`;
    }
    if (autoGuardrails.highRiskRegimes.length > 0) {
      prompt += `\n- ⚠️ ${autoGuardrails.highRiskRegimes.join("/")} 局面で過去 BUY が高確率で負けている (高値掴みパターン)。順張り BUY は確信度 70% 以上に限定`;
    }
    if (autoGuardrails.blockedHourRanges.length > 0) {
      prompt += `\n- ⚠️ JST ${autoGuardrails.blockedHourRanges.join(",")}時 は過去損失集中時間帯。BUY 推奨を控える`;
    }
    prompt += `\n(これは過去の自分の判断データから抽出された事実。同じパターンでの BUY は損失再現リスクが高い)`;
  }

  // マルチタイムフレーム情報を追加
  if (mtf) {
    prompt += `

## マルチタイムフレーム合議 (短期/中期/長期)
- 短期 (数時間): ${mtf.short.label} (score ${mtf.short.score}) — ${mtf.short.reason}
- 中期 (1-2週間): ${mtf.medium.label} (score ${mtf.medium.score}) — ${mtf.medium.reason}
- 長期 (1-3ヶ月): ${mtf.long.label} (score ${mtf.long.score}) — ${mtf.long.reason}
- 3 時間軸合議: ${mtf.consensus}${mtf.bottomFishing ? " 🎯 底値仕込みシグナル" : ""}${mtf.topTaking ? " 🔝 天井利確シグナル" : ""}`;
  }

  prompt += `

## 現在の市場状況
通貨ペア: ${pair}
現在価格: ¥${ticker.price.toLocaleString()}
24h高値: ¥${ticker.high24h.toLocaleString()}
24h安値: ¥${ticker.low24h.toLocaleString()}
24h出来高: ${ticker.volume24h.toFixed(2)}
24h変動率: ${ticker.changePercent24h.toFixed(2)}%
1h変動率: ${signal.changePercent1h.toFixed(2)}%

## 現在のポジション
${hasPosition
  ? `保有あり: ${position.amount} ${pair.split("/")[0]} (時価 ¥${Math.round(positionValueJPY).toLocaleString()})`
  : isDust
    ? `塵ポジション: ${position.amount} ${pair.split("/")[0]} (時価 ¥${Math.round(positionValueJPY)} 未満¥${DUST_POSITION_JPY} → 実質ノーポジ扱い、BUY 余地あり)`
    : "ポジションなし（待機中）"}
JPY残高: ¥${(jpyBalance?.free ?? 0).toLocaleString()}

## 注意事項
- 実質ポジションなし (上記が「ポジションなし」または「塵ポジション」): BUYまたはHOLDのみ
- ポジションあり (上記が「保有あり」): SELLまたはHOLDのみ`;

  if (recentDecisions && recentDecisions.length > 0) {
    const consecutiveHolds = (() => {
      let count = 0;
      for (let i = recentDecisions.length - 1; i >= 0; i--) {
        if (recentDecisions[i].action === "HOLD") count++;
        else break;
      }
      return count;
    })();

    prompt += `\n\n## 直近の判断履歴 (連続HOLD ${consecutiveHolds} 回)\n`;
    for (const d of recentDecisions.slice(-5)) {
      prompt += `- ${d.timestamp}: ${d.action} (確信度${d.confidence}%) ${d.reason}\n`;
    }
    if (consecutiveHolds >= 3) {
      prompt += `\n⚠️ 連続HOLDが${consecutiveHolds}回続いています。daily small win 目標 (毎日少額でも利益) のため、わずかでもシグナルがあればエントリーを検討してください。「ずっとHOLD」は人間の判断と同じで価値がありません。`;
    } else {
      prompt += `\n直近 2 サイクル以内の真逆方向シグナルには慎重に。それ以外の新規シグナルには追従してください。`;
    }
  }

  return prompt;
}
