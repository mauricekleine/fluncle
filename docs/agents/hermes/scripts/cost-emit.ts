// cost-emit.ts — the box's shared, best-effort cost-ledger emitter (COST-01,
// RFC §3 "Path B"). The DRY seam every on-box sweep imports to POST the numbers
// only the box knows: the `claude -p` authoring tokens (note/observe/newsletter,
// `subsidized`), and enrich/embed/render `self` seconds. Vendor calls that run
// INSIDE the Worker (Cartesia/Firecrawl/OpenRouter/Resend) capture in-process
// there (Path A) and never touch this file.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Baked into /opt/hermes-scripts/ alongside the
// sweeps by the Dockerfile's `COPY docs/agents/hermes/scripts/`, so a sibling
// `./cost-emit` import resolves on the box; `*.test.ts` is stripped from the image.
//
// THE CONTRACT (mirrors, deliberately, three things that live in the workspace the
// box CANNOT import — like fluncle-healthcheck.ts mirrors the cron list inline):
//   1. the agent-tier endpoint `POST ${FLUNCLE_API_BASE_URL}/api/admin/costs/events`
//      (packages/contracts/src/orpc/admin-costs.ts), Bearer ${FLUNCLE_API_TOKEN};
//   2. the `CostEventInput` shape + its closed enums (same file);
//   3. the deterministic idempotency `id` scheme (apps/web/src/lib/server/costs.ts
//      `costEventId`) — the server inserts ON CONFLICT(id) DO NOTHING, so a retried
//      or double-emitted row collapses to one.
// If any of the three changes in the workspace, change it here too (the cost-emit
// test pins the id scheme so a silent drift fails a build).
//
// THE GUARANTEE (RFC §3): capture is best-effort and rides AFTER the real work is
// already durable. `emitCost` cannot throw, cannot reject, and cannot block past a
// hard 2.5s timeout — a dropped POST is a permanently-missing ledger row, which for
// a spend ledger only ever UNDERSTATES and never corrupts the pipeline. Zero
// retries: the sweeps run at BATCH_CAP≈1 against a 120s cron kill, so re-POSTing
// would spend the budget the real work needs; emit once and move on.

// The closed enums, mirrored from the `cost_events` typed columns / the
// `CostEventInput` contract (packages/contracts/src/orpc/admin-costs.ts). Kept as
// literal unions so a sweep can't hand `emitCost` a step/vendor the Worker would
// 422 (a rejected batch is a silently-lost row).
export type CostStep =
  | "enrich"
  | "embed"
  | "context"
  | "observe"
  | "note"
  | "video"
  | "publish"
  | "discogs"
  | "lastfm"
  | "newsletter"
  | "studio-clip";
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

/**
 * The semantic facts a box sweep supplies — everything EXCEPT the `id` (this helper
 * derives it) and the Worker-set `createdAt` / priced `estimatedUsd`. `usd` is sent
 * only by `anthropic` rows (the `claude -p` envelope's `total_cost_usd`); every
 * other vendor omits it and the Worker prices from `cost-rates.ts`.
 */
export type BoxCostEvent = {
  costBasis: CostBasis;
  logId?: string | null;
  model?: string | null;
  occurredAt: string; // ISO — when the work was spent
  quantity: number;
  source: CostSource;
  step: CostStep;
  trackId?: string | null;
  unitType: CostUnitType;
  usd?: number | null;
  vendor: CostVendor;
};

/** The full row the endpoint accepts (a `BoxCostEvent` plus its derived `id`). */
export type CostEventPayload = BoxCostEvent & { id: string };

export type EmitCostOptions = {
  /** Override the Worker base (default: FLUNCLE_API_BASE_URL env, then prod). */
  baseUrl?: string;
  /** Injected fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Hard per-POST budget. Default 2500ms (RFC §3 — well inside the 120s cron kill). */
  timeoutMs?: number;
  /** Override the agent token (default: FLUNCLE_API_TOKEN env). */
  token?: string;
};

export type EmitCostResult = { inserted: number; posted: true } | { posted: false; reason: string };

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_BASE_URL = "https://www.fluncle.com";

const log = (message: string) => console.error(`[cost-emit] ${message}`);

/**
 * The deterministic idempotency `id` — a VERBATIM mirror of the server's
 * `costEventId` (apps/web/src/lib/server/costs.ts): `${step}:${scope}:${vendor}:
 * ${unitType}:${occurredAt}` where `scope = logId ?? trackId ?? "global"`. Two
 * identical captures of the same unit of work collapse to one row on insert.
 */
export function costEventId(event: BoxCostEvent): string {
  const scope = event.logId ?? event.trackId ?? "global";

  return `${event.step}:${scope}:${event.vendor}:${event.unitType}:${event.occurredAt}`;
}

/**
 * POST a tick's cost rows to the agent-tier ledger endpoint, BEST-EFFORT. Builds
 * each row's stable `id`, sends the batch with the agent bearer under a hard
 * timeout, and NEVER throws — every failure path (no token, non-2xx, network error,
 * timeout, malformed response) returns a `{ posted: false, reason }` and is logged
 * to stderr, so a ledger hiccup is invisible to the sweep's real work. An empty
 * batch is a no-op. No retries by design.
 */
export async function emitCost(
  events: BoxCostEvent[],
  options: EmitCostOptions = {},
): Promise<EmitCostResult> {
  if (events.length === 0) {
    return { posted: false, reason: "no-events" };
  }

  const baseUrl = (options.baseUrl ?? process.env.FLUNCLE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const token = options.token ?? process.env.FLUNCLE_API_TOKEN ?? "";

  if (!token) {
    log("no FLUNCLE_API_TOKEN — skipping the cost emit");

    return { posted: false, reason: "no-token" };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const payload: CostEventPayload[] = events.map((event) => ({ ...event, id: costEventId(event) }));

  try {
    const response = await doFetch(`${baseUrl}/api/admin/costs/events`, {
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

      return { posted: false, reason: `http-${response.status}` };
    }

    // The endpoint returns `{ ok: true, inserted }`; surface the count so a caller
    // (and a test) can see a retried batch land zero. A missing/odd body is fine —
    // the write already succeeded (2xx); default the count to the batch size.
    let inserted = payload.length;

    try {
      const body = (await response.json()) as { inserted?: unknown };

      if (typeof body.inserted === "number") {
        inserted = body.inserted;
      }
    } catch {
      // Non-JSON 2xx — the write landed; keep the optimistic count.
    }

    return { inserted, posted: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`record_cost POST failed (best-effort, ignored): ${detail}`);

    return { posted: false, reason: "error" };
  }
}
