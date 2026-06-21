// Push notifications via the Expo Push Service (docs/rfcs/mobile-app.md §7). The
// mobile app registers a device token (the `register_device` op); when a finding
// or a mixtape publishes, the publish boundary calls one of the notify functions
// here to reach the crew on their phones.
//
// This mirrors telegram.ts / lastfm.ts — a single non-platform HTTPS caller, kept
// in `apps/web` so the Worker stays the one place that talks to a delivery
// service (APNs/FCM creds live in EAS, never here). The whole feature is a NO-OP
// until `EXPO_ACCESS_TOKEN` is set: `readOptionalEnv` returns undefined, the
// notify functions return immediately, and a publish is never touched.
//
// SAFETY (the swallow-and-continue discipline of the existing publish
// side-channels): the notify functions NEVER throw and NEVER block the publish.
// They schedule the fan-out on `waitUntil` (so the publish response returns
// immediately) and the fan-out itself catches everything. A push failure can
// never fail or delay a finding/mixtape going out.

import { waitUntil } from "cloudflare:workers";
import { logPageUrl } from "../fluncle-links";
import { getDb, typedRows } from "./db";
import { readOptionalEnv } from "./env";

// The Expo Push Service endpoints. `send` accepts ≤100 messages per request;
// `getReceipts` resolves the delivery outcome of previously-sent tickets.
const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

// Expo's hard per-request message ceiling. Larger fan-outs are chunked and the
// chunks POSTed in parallel (each its own request).
const EXPO_CHUNK_SIZE = 100;

// The Android channel a category routes to (createChannelAsync on the client). A
// no-op on iOS. Findings + mixtapes share the default "findings" channel today;
// the mixtape path can split later without a server change.
const FINDINGS_CHANNEL = "findings";
const MIXTAPES_CHANNEL = "mixtapes";

/** The two notification categories — the per-category mute key a device can set. */
export type PushCategory = "findings" | "mixtapes";

// One Expo push message (the subset we send). `data.url` is the in-app deep-link
// target the client routes to on tap.
type ExpoMessage = {
  body: string;
  channelId: string;
  data: { url: string };
  title: string;
  to: string;
};

type PushTokenRow = {
  muted_json: string | null;
  token: string;
};

// An Expo send TICKET — one per message. `status: "ok"` carries a receipt `id`
// (parked for the later receipts sweep); `status: "error"` carries an immediate
// `DeviceNotRegistered` for a token Expo already knows is gone.
type ExpoTicket = {
  details?: { error?: string };
  id?: string;
  message?: string;
  status: "error" | "ok";
};

type ExpoTicketResponse = { data?: ExpoTicket[] };

// An Expo RECEIPT — the delayed delivery outcome, keyed by the ticket's receipt
// id. `DeviceNotRegistered` here is the authoritative dead-token signal.
type ExpoReceipt = {
  details?: { error?: string };
  status: "error" | "ok";
};

type ExpoReceiptResponse = { data?: Record<string, ExpoReceipt> };

/**
 * Split a list into chunks of at most `EXPO_CHUNK_SIZE` — Expo rejects a single
 * /send request carrying more than 100 messages. Exported for the unit test.
 */
export function chunkMessages<T>(items: T[], size = EXPO_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

/**
 * The tokens to notify for a category: every registered device whose `mutedJson`
 * does NOT include that category. A malformed `mutedJson` is treated as "no
 * mutes" (it can't silently swallow a notification). Exported for the unit test.
 */
export function tokensForCategory(rows: PushTokenRow[], category: PushCategory): string[] {
  return rows
    .filter((row) => !mutedCategories(row.muted_json).includes(category))
    .map((row) => row.token);
}

function mutedCategories(mutedJson: string | null): string[] {
  if (!mutedJson?.trim()) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(mutedJson);

    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Notify the crew a new finding is live. Best-effort, gated, fire-and-forget:
 * no-op when `EXPO_ACCESS_TOKEN` is unset; otherwise schedules a `waitUntil`
 * fan-out that never throws. The title/body are in Fluncle's voice (sentence
 * case, no exclamation marks); final copy is a copywriting-fluncle pass.
 */
export function notifyNewFinding(
  track: { artists: string[]; title: string },
  logId?: string,
): void {
  if (!logId?.trim()) {
    return;
  }

  const artistLine = `${track.artists.join(", ")} — ${track.title}`;

  scheduleNotify({
    body: artistLine,
    category: "findings",
    channelId: FINDINGS_CHANNEL,
    title: "fresh banger logged",
    url: logPageUrl(logId),
  });
}

/**
 * Notify the crew a new mixtape is live. Same best-effort, gated, never-throws
 * discipline as `notifyNewFinding`. The mixtape's own log page is the deep-link
 * target (the `/log/<F-marked logId>` surface).
 */
export function notifyNewMixtape(mixtape: { logId?: string; title: string }): void {
  if (!mixtape.logId?.trim()) {
    return;
  }

  scheduleNotify({
    body: mixtape.title,
    category: "mixtapes",
    channelId: MIXTAPES_CHANNEL,
    title: "fresh mixtape on the deck",
    url: logPageUrl(mixtape.logId),
  });
}

// Schedule the fan-out off the request lifecycle. `waitUntil` extends execution
// ~30s past the response, so a large fan-out parallelizes its chunk POSTs to stay
// inside that budget (and the RFC notes a Queue/cron is the move past a few
// thousand tokens). Wrapped so a missing `waitUntil` (Node tests, the turso-dev
// data layer) degrades to a fire-and-forget promise rather than throwing.
function scheduleNotify(notification: {
  body: string;
  category: PushCategory;
  channelId: string;
  title: string;
  url: string;
}): void {
  const task = fanOut(notification);

  try {
    waitUntil(task);
  } catch {
    // No Worker execution context (outside workerd): the promise still runs; we
    // just don't extend the lifecycle. The catch keeps the publish path clean.
    void task;
  }
}

// The actual fan-out. NEVER throws — every failure is swallowed so the publish it
// rides behind is never affected. No-op when the access token is unset (the
// not-configured property): the whole feature ships dark until provisioned.
async function fanOut(notification: {
  body: string;
  category: PushCategory;
  channelId: string;
  title: string;
  url: string;
}): Promise<void> {
  try {
    const accessToken = await readOptionalEnv("EXPO_ACCESS_TOKEN");

    if (!accessToken) {
      return;
    }

    const db = await getDb();
    const result = await db.execute("select token, muted_json from push_tokens");
    const tokens = tokensForCategory(typedRows<PushTokenRow>(result.rows), notification.category);

    if (tokens.length === 0) {
      return;
    }

    const messages: ExpoMessage[] = tokens.map((to) => ({
      body: notification.body,
      channelId: notification.channelId,
      data: { url: notification.url },
      title: notification.title,
      to,
    }));

    // Parallelize the chunk POSTs (allSettled) so the whole fan-out fits the
    // ~30s waitUntil budget and one failed chunk never sinks the rest.
    const settled = await Promise.allSettled(
      chunkMessages(messages).map((chunk) => sendChunk(accessToken, chunk)),
    );

    const tickets = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : [],
    );

    await reapImmediateDeadTokens(db, messages, tickets);
    await parkReceipts(db, messages, tickets);
  } catch {
    // Best-effort: a push failure must never fail or delay a publish.
  }
}

// POST one ≤100-message chunk to Expo /send and return its tickets (positionally
// aligned with the chunk). A non-2xx or a thrown fetch yields no tickets for the
// chunk — swallowed by the caller's allSettled.
async function sendChunk(accessToken: string, chunk: ExpoMessage[]): Promise<ExpoTicket[]> {
  const response = await fetch(EXPO_SEND_URL, {
    body: JSON.stringify(chunk),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as ExpoTicketResponse;

  return body.data ?? [];
}

// Tickets are positionally aligned with the flattened message list (Expo
// preserves order within a chunk, and the chunks were built in order). Map a
// ticket back to its message's token by index. A short tail (fewer tickets than
// messages, from a dropped chunk) simply has no mapping for the missing tail.
function ticketToken(messages: ExpoMessage[], index: number): string | undefined {
  return messages[index]?.to;
}

// `DeviceNotRegistered` on a TICKET (the immediate signal, distinct from the
// delayed receipt one) means Expo already knows the token is gone — prune it now.
async function reapImmediateDeadTokens(
  db: Awaited<ReturnType<typeof getDb>>,
  messages: ExpoMessage[],
  tickets: ExpoTicket[],
): Promise<void> {
  const dead = tickets
    .map((ticket, index) =>
      ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered"
        ? ticketToken(messages, index)
        : undefined,
    )
    .filter((token): token is string => Boolean(token));

  await deleteTokens(db, dead);
}

// Park each OK ticket's receipt id with its token so the receipts sweep
// (sweep_push_receipts) can later resolve the AUTHORITATIVE outcome —
// `DeviceNotRegistered` arrives via receipts ~15min+ after the send, not on the
// ticket. One batched insert keeps the fan-out inside the waitUntil budget.
async function parkReceipts(
  db: Awaited<ReturnType<typeof getDb>>,
  messages: ExpoMessage[],
  tickets: ExpoTicket[],
): Promise<void> {
  const now = new Date().toISOString();
  const statements = tickets.flatMap((ticket, index) => {
    if (ticket.status !== "ok" || !ticket.id) {
      return [];
    }

    const token = ticketToken(messages, index);

    if (!token) {
      return [];
    }

    return [
      {
        args: [ticket.id, token, now],
        sql: `insert into push_receipts (id, token, created_at)
          values (?, ?, ?)
          on conflict(id) do nothing`,
      },
    ];
  });

  if (statements.length > 0) {
    await db.batch(statements, "write");
  }
}

/**
 * Drain the pending-receipt ledger: fetch receipts for parked ticket ids, prune
 * the tokens Expo reports `DeviceNotRegistered`, and delete the resolved ledger
 * rows. Called by the `sweep_push_receipts` admin op (an external cron — TanStack
 * has no `scheduled()`). No-op when the access token is unset. Returns counts for
 * the op's envelope. NEVER throws on a delivery-service hiccup — a sweep failure
 * is reported as zero progress, not an error.
 */
export async function sweepPushReceipts(options: {
  dryRun: boolean;
  limit: number;
}): Promise<{ checked: number; pending: number; pruned: number }> {
  const accessToken = await readOptionalEnv("EXPO_ACCESS_TOKEN");
  const db = await getDb();

  // The ledger size, so the op can report the remaining backlog regardless of the
  // pass budget.
  const pendingResult = await db.execute("select count(*) as c from push_receipts");
  const pending = Number((pendingResult.rows[0] as { c?: number } | undefined)?.c ?? 0);

  if (!accessToken || pending === 0) {
    return { checked: 0, pending, pruned: 0 };
  }

  const batch = await db.execute({
    args: [Math.max(1, Math.min(limitOrDefault(options.limit), 1000))],
    sql: `select id, token from push_receipts order by created_at asc limit ?`,
  });
  const rows = typedRows<{ id: string; token: string }>(batch.rows);
  const receiptIds = rows.map((row) => row.id);

  if (receiptIds.length === 0) {
    return { checked: 0, pending, pruned: 0 };
  }

  let receipts: Record<string, ExpoReceipt> = {};

  try {
    const response = await fetch(EXPO_RECEIPTS_URL, {
      body: JSON.stringify({ ids: receiptIds }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (response.ok) {
      receipts = ((await response.json()) as ExpoReceiptResponse).data ?? {};
    }
  } catch {
    // A receipts-endpoint hiccup: report zero progress, leave the ledger intact.
    return { checked: 0, pending, pruned: 0 };
  }

  const deadTokens = new Set<string>();
  const resolvedIds: string[] = [];

  for (const row of rows) {
    const receipt = receipts[row.id];

    if (!receipt) {
      // Not yet available (receipts lag the send); leave it parked for next pass.
      continue;
    }

    resolvedIds.push(row.id);

    if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
      deadTokens.add(row.token);
    }
  }

  if (options.dryRun) {
    return { checked: resolvedIds.length, pending, pruned: deadTokens.size };
  }

  await deleteTokens(db, [...deadTokens]);
  await deleteReceipts(db, resolvedIds);

  return { checked: resolvedIds.length, pending, pruned: deadTokens.size };
}

function limitOrDefault(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
}

// Delete a set of tokens from the registry (the dead-token prune). Chunked into
// IN-lists so a large prune stays one-statement-per-chunk.
async function deleteTokens(
  db: Awaited<ReturnType<typeof getDb>>,
  tokens: string[],
): Promise<void> {
  for (const chunk of chunkMessages([...new Set(tokens)])) {
    if (chunk.length === 0) {
      continue;
    }

    const placeholders = chunk.map(() => "?").join(", ");

    await db.execute({
      args: chunk,
      sql: `delete from push_tokens where token in (${placeholders})`,
    });
  }
}

async function deleteReceipts(db: Awaited<ReturnType<typeof getDb>>, ids: string[]): Promise<void> {
  for (const chunk of chunkMessages(ids)) {
    if (chunk.length === 0) {
      continue;
    }

    const placeholders = chunk.map(() => "?").join(", ");

    await db.execute({
      args: chunk,
      sql: `delete from push_receipts where id in (${placeholders})`,
    });
  }
}
