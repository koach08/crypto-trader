export type ModelTier = "LIGHT" | "STANDARD" | "HEAVY";

export interface ModelConfig {
  claude: string;
  openai: string;
  gemini: string;
  grok: string;
  perplexity: string;
}

const MODELS = {
  claude: {
    LIGHT: "claude-sonnet-4-6",
    STANDARD: "claude-sonnet-4-6",
    HEAVY: "claude-opus-4-6",
  },
  openai: {
    LIGHT: "gpt-4.1-mini",
    STANDARD: "gpt-4.1",
    HEAVY: "gpt-5",
  },
  gemini: {
    LIGHT: "gemini-2.5-flash",
    STANDARD: "gemini-2.5-pro",
    HEAVY: "gemini-2.5-pro",
  },
  grok: {
    LIGHT: "grok-3-mini-fast-beta",
    STANDARD: "grok-3",
    HEAVY: "grok-3",
  },
  perplexity: {
    LIGHT: "sonar",
    STANDARD: "sonar-pro",
    HEAVY: "sonar-pro",
  },
} as const;

export function getModels(tier: ModelTier): ModelConfig {
  return {
    claude: MODELS.claude[tier],
    openai: MODELS.openai[tier],
    gemini: MODELS.gemini[tier],
    grok: MODELS.grok[tier],
    perplexity: MODELS.perplexity[tier],
  };
}

export function getModel(provider: keyof typeof MODELS, tier: ModelTier): string {
  return MODELS[provider][tier];
}

export const LIGHT = getModels("LIGHT");
export const STANDARD = getModels("STANDARD");
export const HEAVY = getModels("HEAVY");

export const MAX_TOKENS = {
  LIGHT: 1000,
  STANDARD: 4000,
  HEAVY: 8000,
} as const;
