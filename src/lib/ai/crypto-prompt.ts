import type { TickerData, TechnicalSignal } from "../types";

interface PromptParams {
  pair: string;
  ticker: TickerData;
  signal: TechnicalSignal;
  fearGreed: { value: number; label: string };
  position: { amount: number; free: number };
  balance: { currency: string; free: number }[];
  recentDecisions?: { action: string; confidence: number; reason: string; timestamp: string }[];
  paperMode?: boolean;
}

export const CRYPTO_SYSTEM_PROMPT = `あなたは仮想通貨のデイトレード専門AIアナリストです。
提供されるデータを分析し、売買判断を行います。

判断ルール:
1. 複数の指標が同じ方向を示しているときは積極的に売買を推奨する
2. 勝率より損益比（リスクリワード）を重視する
3. ポジションサイズは確信度に比例させる
4. 直近の判断履歴を考慮し、頻繁な売買（フリップフロップ）を避ける
5. Fear & Greedが極端（<20 or >80）な場合は逆張りの好機として評価する
6. RSIがN/Aやデータ不足の場合は他の指標で判断する（RSI不在を理由にHOLDにしない）

必ず以下のJSON形式で返してください（他のテキストは一切不要）:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reason": "判断理由を1-2文で",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "suggested_stop_loss_percent": 数値,
  "suggested_take_profit_percent": 数値
}`;

export const CRYPTO_SYSTEM_PROMPT_PAPER = `あなたは仮想通貨のデイトレード専門AIアナリストです。
これはペーパートレード（検証モード）です。実際の資金リスクはありません。
学習データを最大化するため、積極的に売買判断を行ってください。

判断ルール:
1. 2つ以上の指標が方向を示していれば積極的にBUY/SELLを推奨する
2. Fear & Greedが極端（<20 or >80）な場合は逆張りの絶好機として高確信度で推奨する
3. 確信度は45以上あれば十分。過度に慎重にならない
4. RSIがN/Aやデータ不足でも他の指標だけで判断してよい
5. HOLDは「本当に判断材料がゼロ」の場合のみ
6. 直近HOLDが3回以上続いたペアは、わずかでもシグナルがあればエントリーを検討する

必ず以下のJSON形式で返してください（他のテキストは一切不要）:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reason": "判断理由を1-2文で",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "suggested_stop_loss_percent": 数値,
  "suggested_take_profit_percent": 数値
}`;

export function buildAnalysisPrompt(params: PromptParams): string {
  const { pair, ticker, signal, fearGreed, position, balance, recentDecisions, paperMode } = params;
  const hasPosition = position.amount > 0;
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
Fear & Greed Index: ${fearGreed.value} (${fearGreed.label})

## 現在の市場状況
通貨ペア: ${pair}
現在価格: ¥${ticker.price.toLocaleString()}
24h高値: ¥${ticker.high24h.toLocaleString()}
24h安値: ¥${ticker.low24h.toLocaleString()}
24h出来高: ${ticker.volume24h.toFixed(2)}
24h変動率: ${ticker.changePercent24h.toFixed(2)}%
1h変動率: ${signal.changePercent1h.toFixed(2)}%

## 現在のポジション
${hasPosition ? `保有あり: ${position.amount} ${pair.split("/")[0]}` : "ポジションなし（待機中）"}
JPY残高: ¥${(jpyBalance?.free ?? 0).toLocaleString()}

## 注意事項
- ポジションがない場合: BUYまたはHOLDのみ
- ポジションがある場合: SELLまたはHOLDのみ`;

  if (recentDecisions && recentDecisions.length > 0) {
    prompt += `\n\n## 直近の判断履歴（フリップフロップ防止）\n`;
    for (const d of recentDecisions.slice(-5)) {
      prompt += `- ${d.timestamp}: ${d.action} (確信度${d.confidence}%) ${d.reason}\n`;
    }
    prompt += `\n短時間での逆方向のシグナル転換には慎重に。明確な理由がない限りHOLD推奨。`;
  }

  return prompt;
}
