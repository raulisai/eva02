interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Standard LLM pricing catalogue (per 1M tokens in USD).
 * Supports standard models plus the custom versions defined in EVA's MODEL_CATALOGUE.
 */
const PRICING_CATALOGUE: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o-mini': { inputPerMillion: 0.150, outputPerMillion: 0.600 },
  'gpt-4o': { inputPerMillion: 2.500, outputPerMillion: 10.000 },
  'gpt-4.1-nano': { inputPerMillion: 0.050, outputPerMillion: 0.150 },
  'gpt-4.1-mini': { inputPerMillion: 0.150, outputPerMillion: 0.600 },
  'gpt-4.1': { inputPerMillion: 2.500, outputPerMillion: 10.000 },
  'gpt-3.5-turbo': { inputPerMillion: 0.500, outputPerMillion: 1.500 },
  'gpt-4-turbo': { inputPerMillion: 10.000, outputPerMillion: 30.000 },
  'gpt-4': { inputPerMillion: 30.000, outputPerMillion: 60.000 },
  'gpt-4o-realtime-preview': { inputPerMillion: 5.000, outputPerMillion: 20.000 },

  // Anthropic Claude
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.250, outputPerMillion: 1.250 },
  'claude-3-5-haiku': { inputPerMillion: 0.800, outputPerMillion: 4.000 },
  'claude-sonnet-4-6': { inputPerMillion: 3.000, outputPerMillion: 15.000 },
  'claude-3-5-sonnet': { inputPerMillion: 3.000, outputPerMillion: 15.000 },
  'claude-opus-4-8': { inputPerMillion: 15.000, outputPerMillion: 75.000 },
  'claude-3-opus': { inputPerMillion: 15.000, outputPerMillion: 75.000 },

  // Google Gemini
  'gemini-2.5-flash-lite': { inputPerMillion: 0.075, outputPerMillion: 0.300 },
  'gemini-2.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.300 },
  'gemini-2.5-pro': { inputPerMillion: 1.250, outputPerMillion: 5.000 },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.300 },
  'gemini-1.5-pro': { inputPerMillion: 1.250, outputPerMillion: 5.000 },

  // Dev Stub
  'stub-0': { inputPerMillion: 0.000, outputPerMillion: 0.000 },
  'dev-stub': { inputPerMillion: 0.000, outputPerMillion: 0.000 },
};

const DEFAULT_PRICE: ModelPrice = { inputPerMillion: 0.150, outputPerMillion: 0.600 };

/**
 * Calculates the total cost of a completion request in USD.
 */
export function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  const modelNameLower = model.toLowerCase();
  
  // Find a matching key in the pricing catalogue
  const matchedKey = Object.keys(PRICING_CATALOGUE).find(key => 
    modelNameLower.includes(key.toLowerCase())
  );

  const pricing = matchedKey ? PRICING_CATALOGUE[matchedKey] : DEFAULT_PRICE;
  
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  
  // Round to 8 decimal places to avoid standard JS float issues
  return Math.round((inputCost + outputCost) * 100_000_000) / 100_000_000;
}
