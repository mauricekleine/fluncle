// TIER 4 — the model that translates language into FILTERS, and touches nothing else.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────────────────
// The LLM never sees the archive, never names a track, and never returns one. It is handed
// a sentence and it emits a `SearchFilters` object — `{ artist?, label?, key?, bpmMin?,
// bpmMax?, yearMin?, yearMax?, text?, soundsLike? }` — which `search.ts` then executes as
// SQL over real columns. So a hallucinated track is not a bug we mitigate; it is a thing
// the architecture cannot express. The worst a bad parse can do is filter for something
// that is not in the archive and return an honest empty state.
//
// `soundsLike` is the one place language reaches for a track, and even there it reaches for
// a REFERENCE, not a result: the server resolves that string against the archive, and if it
// resolves to nothing, the sonic tier declines. The vibe is always anchored on a row that
// exists.
//
// ── AND IT IS NEVER ON THE HOT PATH ──────────────────────────────────────────────────
// Three of the four tiers answer without a model at all (a coordinate, an exact entity, a
// bare token — which is most of what anyone types into a search box). This one is reached
// only when the deterministic tiers have all declined, and even then it is on a hard
// deadline: if the model is slow, unprovisioned (no `OPENROUTER_API_KEY` — the local-dev
// steady state), or down, `translateQuery` returns `null` and search falls back to full
// text. It degrades; it never breaks.
//
// Vendor plumbing follows the context-distil precedent (`observation.ts`): a raw `fetch` to
// OpenRouter's chat-completions endpoint (Worker-safe, no SDK), a small cheap model, and the
// billed cost captured into the COST-01 ledger from the same response body.

import { type SearchFilters, SearchFiltersSchema } from "@fluncle/contracts/orpc";
import { priceOpenRouterTokens } from "./cost-rates";
import { captureCostEvents, costEventId } from "./costs";
import { readOptionalEnv } from "./env";
import { PROMPT_REGISTRY, resolvePrompt } from "./prompts";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Small, fast, cheap, and good at structure — this is a parsing job, not a thinking one. */
const DEFAULT_SEARCH_MODEL = "anthropic/claude-haiku-4.5";

/**
 * The deadline. A search box that waits is a search box nobody uses, and the whole point of
 * the tier order is that the model is never what a common query waits on. Past this, the
 * request is abandoned and the caller degrades to full-text — a worse answer, delivered.
 */
const SEARCH_LLM_TIMEOUT_MS = 3_000;

/**
 * The prompt. It is a PARSER's prompt, and every line of it is a rail:
 *
 *   - Emit JSON matching the schema, and nothing else.
 *   - Copy names through VERBATIM (`artist`, `label`, `album`) — do not correct spelling,
 *     do not expand an abbreviation, do not guess a "real" name. SQL matches what is stored;
 *     a helpful correction is a silent wrong answer.
 *   - Never invent a track. `soundsLike` is a REFERENCE the server will resolve, so it
 *     carries the words the user used, not a track the model happens to know.
 *   - Leave a field out when the query does not say it. An unasked-for filter is a lie about
 *     what was asked.
 *   - `text` is the leftover: the words that are neither a name nor a number.
 *
 * Drum & bass lives at 165–180 BPM, so "fast"/"slow" are not absolute words here; the prompt
 * refuses to guess a number the user did not give.
 */
export const SEARCH_FILTER_SYSTEM_PROMPT = PROMPT_REGISTRY.search_filter.defaultBody;

type OpenRouterChatResponse = {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: { completion_tokens?: number; cost?: number; prompt_tokens?: number };
};

/**
 * Pull the filter object out of the model's reply. Tolerant of a stray markdown fence or a
 * sentence of preamble (a small model does that occasionally) by taking the first balanced
 * `{…}` span; anything that still is not JSON, or that Zod rejects, yields `null` and the
 * caller degrades. A model reply is untrusted input, and it is treated like one.
 */
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

  // A filter object with nothing in it is the same as no answer at all — say so, so the
  // caller degrades to full text rather than running an unfiltered "everything" query.
  return Object.values(parsed.data).some((value) => value !== undefined) ? parsed.data : null;
}

/**
 * Translate a natural-language query into `SearchFilters`, or `null` when the model cannot
 * be reached, is too slow, or returns something unusable.
 *
 * NULL IS A SUPPORTED ANSWER, not an error path: it is what happens in local dev (no key),
 * during a vendor outage, and whenever the model exceeds {@link SEARCH_LLM_TIMEOUT_MS}. The
 * caller (`search.ts`) treats it as "degrade to full text", which is why search keeps
 * working when the model does not.
 */
export async function translateQuery(query: string): Promise<SearchFilters | null> {
  const apiKey = await readOptionalEnv("OPENROUTER_API_KEY");

  if (!apiKey) {
    return null; // unprovisioned — the deterministic tiers still answer
  }

  const model = (await readOptionalEnv("OPENROUTER_SEARCH_MODEL")) ?? DEFAULT_SEARCH_MODEL;

  // The system prompt, resolved from the registry: the operator's override if one is on
  // file, else the baked default above. `resolvePrompt` cannot throw and falls back to
  // that default, so the degradation contract below is untouched — search still answers
  // when the prompt store, like the model, is unavailable.
  const prompt = await resolvePrompt("search_filter");

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      body: JSON.stringify({
        messages: [
          { content: prompt.body, role: "system" },
          { content: query, role: "user" },
        ],
        model,
        // Structure, not creativity: the same sentence must parse to the same filters.
        response_format: { type: "json_object" },
        temperature: 0,
        usage: { include: true },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      // The deadline. `AbortSignal.timeout` is Web-Standard and workerd implements it.
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
    // A timeout, a DNS failure, a 5xx that threw — every one of them means the same thing
    // to the caller, and none of them may take search down with them.
    return null;
  }
}

/**
 * Ledger the call (COST-01, Path A — Worker-local, `cash`). BEST-EFFORT by construction:
 * `captureCostEvents` never throws, so a ledger write cannot break a search. Prefers
 * OpenRouter's OWN billed cost (`usage.cost`, credits = USD, requested with
 * `usage: { include: true }`) and falls back to the per-MTok rate table only when the vendor
 * omits it — marking THAT row `estimated`, so a guess never reads as a measured fact.
 *
 * There is no finding here (a search is not about one track), so the row carries no
 * `logId`/`trackId` — the ledger's `step` column already allows a non-finding step, and the
 * idempotency key falls back to the `global` scope.
 */
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
