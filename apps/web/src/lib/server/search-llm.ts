import { type SearchFilters, SearchFiltersSchema } from "@fluncle/contracts/orpc";
import { priceOpenRouterTokens } from "./cost-rates";
import { captureCostEvents, costEventId } from "./costs";
import { readOptionalEnv } from "./env";
import { samplingFor } from "./model-sampling";
import { resolvePrompt } from "./prompts";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_SEARCH_MODEL = "anthropic/claude-haiku-4.5";

const SEARCH_LLM_TIMEOUT_MS = 3_000;

type OpenRouterChatResponse = {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: { completion_tokens?: number; cost?: number; prompt_tokens?: number };
};

export function parseFilterReply(content: string): SearchFilters | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }

  const parsed = SearchFiltersSchema.safeParse(raw);

  if (!parsed.success) {
    return null;
  }

  return Object.values(parsed.data).some((value) => value !== undefined) ? parsed.data : null;
}

export async function translateQuery(query: string): Promise<SearchFilters | null> {
  const apiKey = await readOptionalEnv("OPENROUTER_API_KEY");

  if (!apiKey) {
    return null;
  }

  const model = (await readOptionalEnv("OPENROUTER_SEARCH_MODEL")) ?? DEFAULT_SEARCH_MODEL;

  const reasoningEffort = await readOptionalEnv("OPENROUTER_REASONING_EFFORT");

  const prompt = await resolvePrompt("search_filter");

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      body: JSON.stringify({
        messages: [
          { content: prompt.body, role: "system" },
          { content: query, role: "user" },
        ],
        model,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        response_format: { type: "json_object" },
        ...samplingFor(model, 0),
        usage: { include: true },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(SEARCH_LLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as OpenRouterChatResponse;
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
      return null;
    }

    await captureSearchCost(payload, model);

    return parseFilterReply(content);
  } catch {
    return null;
  }
}

async function captureSearchCost(payload: OpenRouterChatResponse, model: string): Promise<void> {
  const promptTokens = payload.usage?.prompt_tokens;
  const completionTokens = payload.usage?.completion_tokens;

  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") {
    return;
  }

  const billedModel = payload.model ?? model;
  const occurredAt = new Date().toISOString();
  const billedCost = payload.usage?.cost;
  const measured = typeof billedCost === "number";

  await captureCostEvents([
    {
      costBasis: "cash",
      id: costEventId({ occurredAt, step: "search", unitType: "tokens", vendor: "openrouter" }),
      model: billedModel,
      occurredAt,
      quantity: promptTokens + completionTokens,
      source: measured ? "measured" : "estimated",
      step: "search",
      unitType: "tokens",
      usd: measured
        ? billedCost
        : priceOpenRouterTokens(billedModel, promptTokens, completionTokens),
      vendor: "openrouter",
    },
  ]);
}
