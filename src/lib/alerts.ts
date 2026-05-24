/**
 * 通知 (alerts): Slack webhook で重要イベントを通知.
 *
 * 用途:
 *   - 大損 / 連敗 / NAV 急落
 *   - キル損失発火
 *   - cycle 長時間停止
 *   - API エラー連発
 *
 * 抑制:
 *   - 同一 dedupeKey は 30 分以内なら再送しない (spam 防止)
 *   - ALERT_SLACK_WEBHOOK_URL 未設定なら console.warn のみ
 */

export type AlertLevel = "info" | "warn" | "critical";

interface AlertInput {
  level: AlertLevel;
  message: string;
  /** 重複抑制キー (同じイベント種別なら同じキーにする) */
  dedupeKey?: string;
  /** 補足 (Slack の attachment fields に展開) */
  fields?: Record<string, string | number>;
}

// dedupe state: key → last sent timestamp (ms)
const _lastSent = new Map<string, number>();
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: ":information_source:",
  warn: ":warning:",
  critical: ":rotating_light:",
};

function buildSlackPayload(input: AlertInput): Record<string, unknown> {
  const emoji = LEVEL_EMOJI[input.level];
  const fields = input.fields
    ? Object.entries(input.fields).map(([title, value]) => ({
        title,
        value: String(value),
        short: String(value).length < 30,
      }))
    : undefined;

  return {
    text: `${emoji} *[${input.level.toUpperCase()}]* ${input.message}`,
    attachments: fields && fields.length > 0 ? [{ color: input.level === "critical" ? "danger" : input.level === "warn" ? "warning" : "good", fields }] : undefined,
  };
}

/**
 * Alert 発火. dedupe key 30 分以内は無視.
 * webhook 失敗時も throw しない (bot 本流を止めない).
 */
export async function sendAlert(input: AlertInput): Promise<{ sent: boolean; reason?: string }> {
  const key = input.dedupeKey ?? `${input.level}:${input.message.slice(0, 80)}`;
  const last = _lastSent.get(key);
  if (last && Date.now() - last < DEDUPE_WINDOW_MS) {
    return { sent: false, reason: "dedupe" };
  }

  const webhook = process.env.ALERT_SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.warn(`[alert/${input.level}] (webhook 未設定) ${input.message}`);
    _lastSent.set(key, Date.now());
    return { sent: false, reason: "no-webhook" };
  }

  try {
    const payload = buildSlackPayload(input);
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[alert] Slack ${res.status}: ${await res.text().catch(() => "")}`);
      return { sent: false, reason: `http-${res.status}` };
    }
    _lastSent.set(key, Date.now());
    console.log(`[alert/${input.level}] sent: ${input.message}`);
    return { sent: true };
  } catch (e) {
    console.warn("[alert] 送信失敗:", e instanceof Error ? e.message : e);
    return { sent: false, reason: "exception" };
  }
}

/** dedupe をクリア (テスト用) */
export function _clearAlertState(): void {
  _lastSent.clear();
}
