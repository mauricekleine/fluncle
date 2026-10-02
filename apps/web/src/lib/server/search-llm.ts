import { Data, Effect } from "effect";
import { runServerEffect } from "./effect/runtime";
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

function decodeFilterReply(content: string): SearchFilters | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");

  if (start === -1 || end <= start) {
    throw new Error("Missing filter object");
  }

  const raw: unknown = JSON.parse(content.slice(start, end + 1));
  const parsed = SearchFiltersSchema.safeParse(raw);

  if (!parsed.success) {
    throw parsed.error;
  }

  return Object.values(parsed.data).some((value) => value !== undefined) ? parsed.data : null;
}

export function parseFilterReply(content: string): SearchFilters | null {
  try {
    return decodeFilterReply(content);
  } catch {
    return null;
  }
}

class SearchLlmTimeout extends Data.TaggedError("SearchLlmTimeout") {}

class SearchLlmHttpFailed extends Data.TaggedError("SearchLlmHttpFailed")<{ status: number }> {}

class SearchLlmParseFailed extends Data.TaggedError("SearchLlmParseFailed")<{ cause: unknown }> {}

class SearchLlmUnreachable extends Data.TaggedError("SearchLlmUnreachable")<{ cause: unknown }> {}

class SearchLlmCostFailed extends Data.TaggedError("SearchLlmCostFailed")<{ cause: unknown }> {}

type SearchLlmFailure =
  | SearchLlmTimeout
  | SearchLlmHttpFailed
  | SearchLlmParseFailed
  | SearchLlmUnreachable
  | SearchLlmCostFailed;

const logSearchFailure = (error: SearchLlmFailure) =>
  Effect.logWarning("search.llm-failed").pipe(
    Effect.annotateLogs({
      error,
      failure: error._tag,
      ...(error instanceof SearchLlmHttpFailed ? { status: error.status } : {}),
    }),
  );

export async function translateQuery(query: string): Promise<SearchFilters | null> {
  const apiKey = await readOptionalEnv("OPENROUTER_API_KEY");

  if (!apiKey) {
    return null;
  }

  const model = (await readOptionalEnv("OPENROUTER_SEARCH_MODEL")) ?? DEFAULT_SEARCH_MODEL;

  const reasoningEffort = await readOptionalEnv("OPENROUTER_REASONING_EFFORT");

  const prompt = await resolvePrompt("search_filter");

  let readingBody = false;

  const exchange = await runServerEffect(
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof SearchLlmHttpFailed || cause instanceof SearchLlmParseFailed
          ? cause
          : readingBody
            ? new SearchLlmParseFailed({ cause })
            : new SearchLlmUnreachable({ cause }),
      try: async (signal) => {
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
          signal,
        });

        if (!response.ok) {
          throw new SearchLlmHttpFailed({ status: response.status });
        }

        readingBody = true;
        const payload = (await response.json()) as OpenRouterChatResponse;
        const content = payload.choices?.[0]?.message?.content;

        if (typeof content !== "string") {
          throw new SearchLlmParseFailed({ cause: "Missing filter reply" });
        }

        return { content, payload };
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: SEARCH_LLM_TIMEOUT_MS,
        orElse: () => Effect.fail(new SearchLlmTimeout()),
      }),
      Effect.catch((error) => logSearchFailure(error).pipe(Effect.as(null))),
    ),
  );

  if (!exchange) {
    return null;
  }

  try {
    await captureSearchCost(exchange.payload, model);
  } catch (cause) {
    await runServerEffect(logSearchFailure(new SearchLlmCostFailed({ cause })));

    return null;
  }

  return runServerEffect(
    Effect.try({
      catch: (cause) => new SearchLlmParseFailed({ cause }),
      try: () => decodeFilterReply(exchange.content),
    }).pipe(Effect.catch((error) => logSearchFailure(error).pipe(Effect.as(null)))),
  );
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
