import { randomUUID } from "node:crypto";
import { type ClipDTO } from "@fluncle/contracts/orpc";
import { buildCaptionForClip } from "./clip-caption-builder";
import { nextDripSlot, upsertClipPost } from "./clip-social";
import { getDb, typedRow, typedRows } from "./db";
import { logEvent } from "./log";
import { getRecording } from "./recordings";
import { ApiError } from "./spotify";

const captionMaxLength = 600;

type ClipRow = {
  caption: string | null;
  created_at: string;
  id: string;
  in_ms: number;
  out_ms: number;
  recording_id: string | null;
  status: "done" | "pending";
  updated_at: string;
  x_offset: number;
};

export type ClipInput = {
  caption?: unknown;
  inMs?: unknown;
  outMs?: unknown;
  status?: unknown;
  xOffset?: unknown;
};

function rowToClip(row: ClipRow): ClipDTO {
  return {
    caption: row.caption ?? undefined,
    createdAt: row.created_at,
    id: row.id,
    inMs: row.in_ms,
    outMs: row.out_ms,
    recordingId: row.recording_id ?? undefined,
    status: row.status,
    updatedAt: row.updated_at,
    xOffset: row.x_offset,
  };
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);

  if (typeof value !== "number" || !Number.isInteger(number) || number < 0) {
    throw new ApiError("invalid_input", `${field} must be a non-negative integer (ms)`, 400);
  }

  return number;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireNonNegativeInteger(value, field);
}

function optionalCaption(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError("invalid_input", "caption must be text", 400);
  }

  return value.trim() ? value.trim().slice(0, captionMaxLength) : null;
}

function optionalStatus(value: unknown): "done" | "pending" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "pending" && value !== "done") {
    throw new ApiError("invalid_status", 'Clip status must be "pending" or "done"', 400);
  }

  return value;
}

function assertWindow(inMs: number, outMs: number): void {
  if (outMs <= inMs) {
    throw new ApiError("invalid_window", "A clip's out point must be after its in point", 400);
  }
}

async function getClipRow(clipId: string): Promise<ClipRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [clipId],
    sql: `select id, recording_id, in_ms, out_ms, x_offset, caption, status, created_at, updated_at
          from mixtape_clips where id = ? limit 1`,
  });
  const row = typedRow<ClipRow>(result.rows);

  if (!row) {
    throw new ApiError("clip_not_found", "Clip not found", 404);
  }

  return row;
}

export async function getClip(clipId: string): Promise<ClipDTO> {
  return rowToClip(await getClipRow(clipId));
}

export async function markClipCutDone(clipId: string): Promise<ClipDTO> {
  return updateClip(clipId, { status: "done" });
}

export async function createClip(recordingId: string, input: ClipInput): Promise<ClipDTO> {
  await getRecording(recordingId);

  const inMs = requireNonNegativeInteger(input.inMs, "inMs");
  const outMs = requireNonNegativeInteger(input.outMs, "outMs");

  assertWindow(inMs, outMs);

  const xOffset = requireNonNegativeInteger(input.xOffset, "xOffset");
  const caption = optionalCaption(input.caption) ?? null;
  const status = optionalStatus(input.status) ?? "pending";
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [id, recordingId, inMs, outMs, xOffset, caption, status, now, now],
    sql: `insert into mixtape_clips
            (id, recording_id, in_ms, out_ms, x_offset, caption, status, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  try {
    const built = await buildCaptionForClip(await getClip(id));
    await upsertClipPost({
      caption: built.builtCaption,
      clipId: id,
      scheduledFor: await nextDripSlot(),
    });
  } catch (error) {
    logEvent("warn", "clips.auto-queue-failed", { clipId: id, error });
  }

  return rowToClip(await getClipRow(id));
}

export async function updateClip(clipId: string, input: ClipInput): Promise<ClipDTO> {
  const current = await getClipRow(clipId);

  const inMs = optionalNonNegativeInteger(input.inMs, "inMs");
  const outMs = optionalNonNegativeInteger(input.outMs, "outMs");
  const xOffset = optionalNonNegativeInteger(input.xOffset, "xOffset");
  const caption = optionalCaption(input.caption);
  const status = optionalStatus(input.status);

  assertWindow(inMs ?? current.in_ms, outMs ?? current.out_ms);

  const sets: string[] = [];
  const args: Array<number | string | null> = [];

  for (const [column, value] of [
    ["in_ms", inMs],
    ["out_ms", outMs],
    ["x_offset", xOffset],
    ["caption", caption],
    ["status", status],
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
  args.push(new Date().toISOString(), clipId);

  const db = await getDb();
  await db.execute({ args, sql: `update mixtape_clips set ${sets.join(", ")} where id = ?` });

  return rowToClip(await getClipRow(clipId));
}

export async function deleteClip(clipId: string): Promise<void> {
  await getClipRow(clipId);

  const db = await getDb();
  await db.execute({ args: [clipId], sql: `delete from mixtape_clips where id = ?` });
}

export async function listClips(
  filter: { recordingId?: string; status?: string } = {},
): Promise<ClipDTO[]> {
  const conditions: string[] = [];
  const args: string[] = [];

  if (filter.recordingId) {
    conditions.push("recording_id = ?");
    args.push(filter.recordingId);
  }

  if (filter.status !== undefined) {
    const status = optionalStatus(filter.status);

    if (status !== undefined) {
      conditions.push("status = ?");
      args.push(status);
    }
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const db = await getDb();
  const result = await db.execute({
    args,
    sql: `select id, recording_id, in_ms, out_ms, x_offset, caption, status, created_at, updated_at
          from mixtape_clips ${where} order by created_at desc, id desc`,
  });

  return typedRows<ClipRow>(result.rows).map(rowToClip);
}
