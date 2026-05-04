import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getModel, MAX_TOKENS } from "../model-config";
import { parseAiJson } from "../json-utils";
import type { EngineId, EngineResult, CryptoAction, RiskLevel } from "../types";
import { CRYPTO_SYSTEM_PROMPT, CRYPTO_SYSTEM_PROMPT_PAPER } from "./crypto-prompt";

let _paperMode = false;
export function setEnginesPaperMode(v: boolean) { _paperMode = v; }
function getSystemPrompt() { return _paperMode ? CRYPTO_SYSTEM_PROMPT_PAPER : CRYPTO_SYSTEM_PROMPT; }

interface AIResponse {
  action: CryptoAction;
  confidence: number;
  reason: string;
  risk_level: RiskLevel;
  suggested_stop_loss_percent: number;
  suggested_take_profit_percent: number;
}

function parseResponse(text: string, engine: EngineId, duration: number): EngineResult {
  const parsed = parseAiJson<AIResponse>(text, (obj) =>
    typeof obj.action === "string" && typeof obj.confidence === "number"
  );

  if (!parsed) {
    return { engine, status: "error", error: "Failed to parse AI response", duration };
  }

  const action = (["BUY", "SELL", "HOLD"].includes(parsed.action) ? parsed.action : "HOLD") as CryptoAction;
  const confidence = Math.max(0, Math.min(100, parsed.confidence));

  return {
    engine,
    status: "success",
    action,
    confidence,
    summary: parsed.reason,
    suggestedStopLoss: parsed.suggested_stop_loss_percent,
    suggestedTakeProfit: parsed.suggested_take_profit_percent,
    duration,
  };
}

async function runClaude(userMessage: string, tier: "STANDARD" | "HEAVY"): Promise<EngineResult> {
  const start = Date.now();
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: getModel("claude", tier),
      max_tokens: MAX_TOKENS[tier],
      system: getSystemPrompt(),
      messages: [{ role: "user", content: userMessage }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    return parseResponse(text, "claude", Date.now() - start);
  } catch (e) {
    return { engine: "claude", status: "error", error: String(e), duration: Date.now() - start };
  }
}

async function runOpenAI(userMessage: string, tier: "STANDARD" | "HEAVY", engine: "gpt4o" | "grok" | "perplexity"): Promise<EngineResult> {
  const start = Date.now();
  const providerMap: Record<string, { key: string; baseURL?: string; provider: "openai" | "grok" | "perplexity" }> = {
    gpt4o: { key: process.env.OPENAI_API_KEY || "", provider: "openai" },
    grok: { key: process.env.GROK_API_KEY || "", baseURL: "https://api.x.ai/v1", provider: "grok" },
    perplexity: { key: process.env.PERPLEXITY_API_KEY || "", baseURL: "https://api.perplexity.ai", provider: "perplexity" },
  };
  const cfg = providerMap[engine];

  try {
    const client = new OpenAI({ apiKey: cfg.key, baseURL: cfg.baseURL });
    const resp = await client.chat.completions.create({
      model: getModel(cfg.provider, tier),
      max_tokens: MAX_TOKENS[tier],
      messages: [
        { role: "system", content: getSystemPrompt() },
        { role: "user", content: userMessage },
      ],
    });
    const text = resp.choices[0]?.message?.content || "";
    return parseResponse(text, engine, Date.now() - start);
  } catch (e) {
    return { engine, status: "error", error: String(e), duration: Date.now() - start };
  }
}

async function runGemini(userMessage: string, tier: "STANDARD" | "HEAVY"): Promise<EngineResult> {
  const start = Date.now();
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    const model = genAI.getGenerativeModel({ model: getModel("gemini", tier) });
    const resp = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: getSystemPrompt() + "\n\n" + userMessage }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS[tier] },
    });
    const text = resp.response.text();
    return parseResponse(text, "gemini", Date.now() - start);
  } catch (e) {
    return { engine: "gemini", status: "error", error: String(e), duration: Date.now() - start };
  }
}

export async function runAllEngines(
  userMessage: string,
  tier: "STANDARD" | "HEAVY" = "STANDARD"
): Promise<EngineResult[]> {
  // Grok disabled: unpaid credits, 0% success rate across 100+ calls
  const results = await Promise.allSettled([
    runClaude(userMessage, tier),
    runOpenAI(userMessage, tier, "gpt4o"),
    runGemini(userMessage, tier),
    runOpenAI(userMessage, tier, "perplexity"),
  ]);

  return results.map((r, i) => {
    const engines: EngineId[] = ["claude", "gpt4o", "gemini", "perplexity"];
    if (r.status === "fulfilled") return r.value;
    return { engine: engines[i], status: "error" as const, error: String(r.reason), duration: 0 };
  });
}

export async function runSingleEngine(
  userMessage: string,
  tier: "STANDARD" | "HEAVY" = "STANDARD"
): Promise<EngineResult> {
  return runClaude(userMessage, tier);
}
