import { waitUntil } from "cloudflare:workers";
import { type PushCategory } from "@fluncle/contracts";
import { logPageUrl } from "../fluncle-links";
import { getDb, typedRows } from "./db";
import { readOptionalEnv } from "./env";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

const EXPO_CHUNK_SIZE = 100;

const FINDINGS_CHANNEL = "findings";
const MIXTAPES_CHANNEL = "mixtapes";

export type { PushCategory };

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

type ExpoTicket = {
  details?: { error?: string };
  id?: string;
  message?: string;
  status: "error" | "ok";
};

type ExpoTicketResponse = { data?: ExpoTicket[] };

type ExpoReceipt = {
  details?: { error?: string };
  status: "error" | "ok";
};

type ExpoReceiptResponse = { data?: Record<string, ExpoReceipt> };

export function chunkMessages<T>(items: T[], size = EXPO_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

export function tokensForCategory(rows: PushTokenRow[], category: PushCategory): string[] {
  return rows.flatMap((row) =>
    mutedCategories(row.muted_json).includes(category) ? [] : [row.token],
  );
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
    title: "Fresh banger logged",
    url: logPageUrl(logId),
  });
}

export function notifyNewMixtape(mixtape: { logId?: string; title: string }): void {
  if (!mixtape.logId?.trim()) {
    return;
  }

  scheduleNotify({
    body: mixtape.title,
    category: "mixtapes",
    channelId: MIXTAPES_CHANNEL,
    title: "Fresh mixtape on the deck",
    url: logPageUrl(mixtape.logId),
  });
}

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
    void task;
  }
}

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

    const settled = await Promise.allSettled(
      chunkMessages(messages).map((chunk) => sendChunk(accessToken, chunk)),
    );

    const tickets = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : [],
    );

    await reapImmediateDeadTokens(db, messages, tickets);
    await parkReceipts(db, messages, tickets);
  } catch {}
}

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

function ticketToken(messages: ExpoMessage[], index: number): string | undefined {
  return messages[index]?.to;
}

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

export async function sweepPushReceipts(options: {
  dryRun: boolean;
  limit: number;
}): Promise<{ checked: number; pending: number; pruned: number }> {
  const [accessToken, db] = await Promise.all([readOptionalEnv("EXPO_ACCESS_TOKEN"), getDb()]);

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
    return { checked: 0, pending, pruned: 0 };
  }

  const deadTokens = new Set<string>();
  const resolvedIds: string[] = [];

  for (const row of rows) {
    const receipt = receipts[row.id];

    if (!receipt) {
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
