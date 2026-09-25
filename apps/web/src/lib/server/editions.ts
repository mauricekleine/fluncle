import { randomUUID } from "node:crypto";
import { type EditionDTO } from "@fluncle/contracts";
import { rowToEdition } from "../editions";
import { captureCostEvents, costEventId } from "./costs";
import { getDb, typedRow, typedRows } from "./db";
import { renderEditionEmailHtml } from "./edition-email";
import { countSegmentRecipients, createBroadcast, sendBroadcast } from "./resend";
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

const EDITION_SELECT = `select
  id, number, status, subject, content_json,
  window_since, window_until, send_provider, send_external_id,
  sent_at, added_at, created_at, updated_at
  from editions`;

export type EditionInput = {
  contentJson?: unknown;

  promptVersion?: number | null;
  subject?: unknown;
  windowSince?: unknown;
  windowUntil?: unknown;
};

type FindingShape = { galaxies?: Array<{ findings?: unknown[] }>; mixtapeRef?: unknown };

function editionHasFindings(content: FindingShape): boolean {
  const findingCount = (content.galaxies ?? []).reduce(
    (sum, block) => sum + (block.findings?.length ?? 0),
    0,
  );
  return (
    findingCount > 0 || (typeof content.mixtapeRef === "string" && content.mixtapeRef.trim() !== "")
  );
}

function parseEditionContent(contentJson: string): FindingShape {
  try {
    const parsed: unknown = JSON.parse(contentJson);
    return typeof parsed === "object" && parsed !== null ? (parsed as FindingShape) : {};
  } catch {
    return {};
  }
}

export async function createEdition(input: EditionInput): Promise<EditionDTO> {
  const fields = validateEditionInput(input, { requireContent: true });

  if (fields.contentJson === undefined) {
    throw new ApiError("invalid_content", "An edition needs a content payload", 400);
  }

  if (!editionHasFindings(parseEditionContent(fields.contentJson))) {
    throw new ApiError("empty_edition", "An edition needs at least one finding or a mixtape", 400);
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
      input.promptVersion ?? null,
      fields.windowSince ?? null,
      fields.windowUntil ?? null,
      now,
      now,
    ],
    sql: `insert into editions (
        id, status, subject, content_json, prompt_version,
        window_since, window_until, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  return getEditionById(id, { includeDrafts: true });
}

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

  if (!editionHasFindings(draft.content)) {
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

  const recipients = options.scheduledAt ? null : await countSegmentRecipients();

  if (typeof recipients === "number" && recipients > 0) {
    const occurredAt = new Date().toISOString();

    await captureCostEvents([
      {
        costBasis: "cash",
        id: costEventId({
          occurredAt,
          step: "newsletter",
          unitType: "emails",
          vendor: "resend",
        }),
        occurredAt,
        quantity: recipients,
        source: "estimated",
        step: "newsletter",
        unitType: "emails",
        vendor: "resend",
      },
    ]);
  }

  return getEditionById(id, { includeDrafts: true });
}

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

export async function getEditionByNumber(number: number): Promise<EditionDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [number],
    sql: `${EDITION_SELECT} where number = ? and status = 'sent' limit 1`,
  });
  const row = typedRow<EditionRow>(result.rows);

  return row ? rowToEdition(row) : undefined;
}

async function getEditionById(
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
