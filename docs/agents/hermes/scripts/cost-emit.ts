export type CostStep =
  | "enrich"
  | "embed"
  | "context"
  | "observe"
  | "note"
  | "bio"
  | "video"
  | "publish"
  | "discogs"
  | "lastfm"
  | "newsletter"
  | "studio-clip"
  | "cluster";
export type CostVendor =
  | "anthropic"
  | "openrouter"
  | "cartesia"
  | "firecrawl"
  | "apify"
  | "resend"
  | "self";
export type CostUnitType = "tokens" | "characters" | "seconds" | "requests" | "emails";
export type CostBasis = "cash" | "subsidized";
export type CostSource = "measured" | "estimated";

export type BoxCostEvent = {
  costBasis: CostBasis;
  logId?: string | null;
  model?: string | null;
  occurredAt: string;
  quantity: number;
  source: CostSource;
  step: CostStep;
  trackId?: string | null;
  unitType: CostUnitType;
  usd?: number | null;
  vendor: CostVendor;
};

export type CostEventPayload = BoxCostEvent & { id: string };

export type EmitCostOptions = {
  baseUrl?: string;

  fetchImpl?: typeof fetch;

  timeoutMs?: number;

  token?: string;
};

export type EmitCostResult =
  | { failed: 0; inserted: number; posted: true }
  | { failed: number; posted: false; reason: string };

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BASE_URL = "https://www.fluncle.com";

const log = (message: string) => console.error(`[cost-emit] ${message}`);

export type ClaudeAuthoringReply = {
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function parseAuthoringSpend(
  reply: ClaudeAuthoringReply,
  fallbackModel: string,
): { model: string; tokens: number; usd: number | null } {
  const usage = reply.usage;
  const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const model = Object.keys(reply.modelUsage ?? {})[0] ?? fallbackModel;
  const usd = typeof reply.total_cost_usd === "number" ? reply.total_cost_usd : null;

  return { model, tokens, usd };
}

export function selfSecondsCost(input: {
  logId?: string | null;
  occurredAt: string;
  seconds: number;
  step: CostStep;
  trackId?: string | null;
}): BoxCostEvent {
  return {
    costBasis: "subsidized",
    logId: input.logId ?? null,
    occurredAt: input.occurredAt,
    quantity: Math.max(0, Math.round(input.seconds)),
    source: "measured",
    step: input.step,
    trackId: input.trackId ?? null,
    unitType: "seconds",
    vendor: "self",
  };
}

export function costEventId(event: BoxCostEvent): string {
  const scope = event.logId ?? event.trackId ?? "global";

  return `${event.step}:${scope}:${event.vendor}:${event.unitType}:${event.occurredAt}`;
}

export async function emitCost(
  events: BoxCostEvent[],
  options: EmitCostOptions = {},
): Promise<EmitCostResult> {
  if (events.length === 0) {
    return { failed: 0, posted: false, reason: "no-events" };
  }

  const baseUrl = (options.baseUrl ?? process.env.FLUNCLE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const token = options.token ?? process.env.FLUNCLE_API_TOKEN ?? "";

  if (!token) {
    log("no FLUNCLE_API_TOKEN — skipping the cost emit");

    return { failed: events.length, posted: false, reason: "no-token" };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const payload: CostEventPayload[] = events.map((event) => ({ ...event, id: costEventId(event) }));

  try {
    const response = await doFetch(`${baseUrl}/api/v1/admin/costs/events`, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      log(`record_cost POST returned HTTP ${response.status} (best-effort, ignored)`);

      return { failed: events.length, posted: false, reason: `http-${response.status}` };
    }

    let inserted = payload.length;

    try {
      const body = (await response.json()) as { inserted?: unknown };

      if (typeof body.inserted === "number") {
        inserted = body.inserted;
      }
    } catch {}

    return { failed: 0, inserted, posted: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`record_cost POST failed (best-effort, ignored): ${detail}`);

    return { failed: events.length, posted: false, reason: "error" };
  }
}
