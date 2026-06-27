import { randomUUID } from "node:crypto";
import { type EditionDTO } from "@fluncle/contracts";
import { rowToEdition } from "../editions";
import { getDb, typedRow, typedRows } from "./db";
import { renderEditionEmailHtml } from "./edition-email";
import { createBroadcast, sendBroadcast } from "./resend";
import { ApiError } from "./spotify";

const subjectMaxLength = 200;
const contentMaxBytes = 200_000;

type EditionRow = {
  added_at: string | null;
  content_json: string;
  created_at: string;
  id: string;
  number: number | null;
  sent_at: string | null;
  status: "draft" | "sent";
  subject: string | null;
  updated_at: string | null;
  window_since: string | null;
  window_until: string | null;
};

type SendRow = {
  number: number;
};

// The columns every read selects — the editions table is flat (no joins, unlike
// MIXTAPE_SELECT), so this is the plain projection.
const EDITION_SELECT = `select
  id, number, status, subject, content_json,
  window_since, window_until, send_provider, send_external_id,
  sent_at, added_at, created_at, updated_at
  from editions`;

// ── The agent-authored draft input ───────────────────────────────────────────

export type EditionInput = {
  contentJson?: unknown;
  subject?: unknown;
  windowSince?: unknown;
  windowUntil?: unknown;
};

/**
 * Create a DRAFT edition (no number yet — the archive's source of truth, persisted
 * at author time). Mirrors `createMixtape`: a `randomUUID` id, the operator/agent's
 * authored payload, status `draft`. The number is minted only on send.
 */
export async function createEdition(input: EditionInput): Promise<EditionDTO> {
  const fields = validateEditionInput(input, { requireContent: true });

  // `requireContent` guarantees a non-undefined payload; assert it for the type.
  if (fields.contentJson === undefined) {
    throw new ApiError("invalid_content", "An edition needs a content payload", 400);
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const db = await getDb();

  await db.execute({
    args: [
      id,
      "draft",
      fields.subject ?? null,
      fields.contentJson,
      fields.windowSince ?? null,
      fields.windowUntil ?? null,
      now,
      now,
    ],
    sql: `insert into editions (
        id, status, subject, content_json,
        window_since, window_until, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  return getEditionById(id, { includeDrafts: true });
}

/** Edit a draft's payload/subject/window before send. Sent editions are frozen. */
export async function updateEdition(id: string, input: EditionInput): Promise<EditionDTO> {
  const current = await getEditionById(id, { includeDrafts: true });

  if (current.status === "sent") {
    throw new ApiError(
      "edition_sent",
      "A sent edition is a permanent back-issue and is frozen",
      409,
    );
  }

  const fields = validateEditionInput(input, { requireContent: false });
  const sets: string[] = [];
  const args: Array<string | null> = [];

  for (const [column, value] of [
    ["subject", fields.subject],
    ["content_json", fields.contentJson],
    ["window_since", fields.windowSince],
    ["window_until", fields.windowUntil],
  ] as const) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      args.push(value ?? null);
    }
  }

  if (sets.length === 0) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  sets.push("updated_at = ?");
  args.push(new Date().toISOString(), id);

  const db = await getDb();
  await db.execute({ args, sql: `update editions set ${sets.join(", ")} where id = ?` });

  return getEditionById(id, { includeDrafts: true });
}

/**
 * Send a draft as a Resend broadcast and, on success, MINT the sequential number.
 * The send is the operator's explicit human gate (the old Loops dashboard tap).
 *
 *   1. render the email HTML from the stored `contentJson` (one source → two
 *      renders, the archive page being the other),
 *   2. create the broadcast to the Fluncle segment (a draft on Resend's side),
 *   3. send it (or schedule via `scheduledAt`),
 *   4. atomically mint `number = max(number)+1`, flip to `sent`, record provenance.
 *
 * The mint-on-send keeps numbering honest — a drafted-but-never-sent edition never
 * claims a number. The Resend key is the Worker's; the agent only reaches this via
 * the operator-tier admin op.
 */
export async function sendEdition(
  id: string,
  options: { scheduledAt?: string } = {},
): Promise<EditionDTO> {
  const draft = await getEditionById(id, { includeDrafts: true });

  if (draft.status === "sent") {
    throw new ApiError(
      "already_sent",
      "This edition already went out — re-sending would double-mail the list",
      409,
    );
  }

  if (!draft.subject?.trim()) {
    throw new ApiError("missing_subject", "An edition needs a subject before it can be sent", 409);
  }

  // A real edition carries at least one finding or a mixtape — never a hollow,
  // intro-only shell. (The agent once authored editions with the `galaxies` array
  // dropped, and a find-less edition mailed out empty; this is the server-side
  // backstop so it can't happen again, matching the doctrine's zero-find rule.)
  const findingCount = (draft.content.galaxies ?? []).reduce(
    (sum, block) => sum + block.findings.length,
    0,
  );
  if (findingCount === 0 && !draft.content.mixtapeRef?.trim()) {
    throw new ApiError(
      "empty_edition",
      "An edition needs at least one finding or a mixtape before it can be sent",
      409,
    );
  }

  const html = await renderEditionEmailHtml(draft);

  const broadcast = await createBroadcast({
    editionId: id,
    html,
    name: draft.subject,
    subject: draft.subject,
  });

  await sendBroadcast(broadcast.id, options);

  // Mint atomically: `max(number)+1`, guarded on `status='draft'` so a concurrent
  // double-send can't mint twice. A null row means the guard failed (already sent).
  const now = new Date().toISOString();
  const db = await getDb();
  const [result] = await db.batch(
    [
      {
        args: [broadcast.id, now, now, now, id],
        sql: `with next_number(n) as (
                select coalesce(max(number), 0) + 1 from editions where number is not null
              )
              update editions
              set
                number = (select n from next_number),
                status = 'sent',
                send_provider = 'resend',
                send_external_id = ?,
                sent_at = ?,
                added_at = ?,
                updated_at = ?
              where id = ?
                and status = 'draft'
              returning number`,
      },
    ],
    "write",
  );

  if (!result) {
    throw new ApiError("send_failed", "Edition could not be marked sent", 409);
  }

  const row = typedRow<SendRow>(result.rows);

  if (!row) {
    throw new ApiError("send_failed", "Edition could not be marked sent", 409);
  }

  return getEditionById(id, { includeDrafts: true });
}

/**
 * HARD-delete an edition row by id, at ANY status — drafts AND sent. Unlike
 * `updateEdition` (which freezes a sent back-issue), delete must reach a sent
 * edition: a test edition that already went out is exactly what the operator needs
 * to pull from the public archive. This removes ONLY the DB row — the Resend
 * broadcast it sent is already gone and is not touched. A deleted `number` leaves
 * a gap in the sequence; that's fine (the public archive reads by number, and a
 * missing one 404s gracefully via `getEditionByNumber`). Operator-tier only.
 */
export async function deleteEdition(id: string): Promise<{ id: string }> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `delete from editions where id = ? returning id`,
  });

  const row = typedRow<{ id: string }>(result.rows);

  if (!row) {
    throw new ApiError("edition_not_found", "Edition not found", 404);
  }

  return { id: row.id };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The public archive list: sent editions, newest first. */
export async function listEditions({
  includeDrafts = false,
  limit = 100,
}: { includeDrafts?: boolean; limit?: number } = {}): Promise<EditionDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 500)],
    sql: `${EDITION_SELECT}
          ${includeDrafts ? "" : "where status = 'sent'"}
          order by coalesce(added_at, created_at) desc, id desc
          limit ?`,
  });

  return typedRows<EditionRow>(result.rows).map((row) => rowToEdition(row));
}

/** A single sent edition by its integer number (the public `/newsletter/<id>` read). */
export async function getEditionByNumber(number: number): Promise<EditionDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [number],
    sql: `${EDITION_SELECT} where number = ? and status = 'sent' limit 1`,
  });
  const row = typedRow<EditionRow>(result.rows);

  return row ? rowToEdition(row) : undefined;
}

/** A single edition by its uuid (admin path — drafts inclusive when asked). */
export async function getEditionById(
  id: string,
  options: { includeDrafts?: boolean } = {},
): Promise<EditionDTO> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `${EDITION_SELECT} where id = ? ${options.includeDrafts ? "" : "and status = 'sent'"} limit 1`,
  });
  const row = typedRow<EditionRow>(result.rows);

  if (!row) {
    throw new ApiError("edition_not_found", "Edition not found", 404);
  }

  return rowToEdition(row);
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateEditionInput(
  input: EditionInput,
  options: { requireContent: boolean },
): {
  contentJson?: string;
  subject?: string | null;
  windowSince?: string | null;
  windowUntil?: string | null;
} {
  return {
    contentJson: validateContent(input.contentJson, options.requireContent),
    subject: optionalText(input.subject, subjectMaxLength),
    windowSince: optionalIsoDate(input.windowSince, "windowSince"),
    windowUntil: optionalIsoDate(input.windowUntil, "windowUntil"),
  };
}

// The content payload is stored as JSON TEXT. Accept either a pre-serialized JSON
// string or a structured object (the agent may send either); always store a
// canonical JSON string. A missing payload is allowed on update (a metadata-only
// edit) but required on create.
function validateContent(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw new ApiError("invalid_content", "An edition needs a content payload", 400);
    }

    return undefined;
  }

  let serialized: string;

  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new ApiError("invalid_content", "content must be valid JSON", 400);
    }

    serialized = value;
  } else if (typeof value === "object") {
    serialized = JSON.stringify(value);
  } else {
    throw new ApiError("invalid_content", "content must be a JSON object or string", 400);
  }

  if (serialized.length > contentMaxBytes) {
    throw new ApiError("content_too_large", "The edition payload is too large", 400);
  }

  return serialized;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError("invalid_input", "Expected text input", 400);
  }

  return value.trim() ? value.trim().slice(0, maxLength) : null;
}

function optionalIsoDate(value: unknown, field: string): string | null | undefined {
  const text = optionalText(value, 80);

  if (text === undefined || text === null) {
    return text;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError("invalid_date", `${field} must be a valid date`, 400);
  }

  return date.toISOString();
}
