// The mixtape-clip data layer (Fluncle Studio Unit D; docs/fluncle-studio-rfc.md
// §5). A clip is a lightweight 9:16 derivative cut from a mixtape's set video — many
// per set, NOT a spine object (no Log ID). This module owns the clip CRUD the admin
// `list_clips`/`create_clip`/`update_clip`/`delete_clip` ops are thin wrappers over;
// the cue backfill (`setMixtapeCues`) lives in `./mixtapes` (it re-times the
// tracklist, not a clip). Mirrors the validate-and-throw style of `./mixtapes`.

import { randomUUID } from "node:crypto";
import { type ClipDTO } from "@fluncle/contracts/orpc";
import { getDb, typedRow, typedRows } from "./db";
import { getMixtapeById } from "./mixtapes";
import { ApiError } from "./spotify";

const captionMaxLength = 600;

type ClipRow = {
  caption: string | null;
  created_at: string;
  id: string;
  in_ms: number;
  mixtape_id: string;
  out_ms: number;
  status: "done" | "pending";
  updated_at: string;
  x_offset: number;
};

// The operator/agent-authored fields a clip create accepts. The cut window
// (`inMs`/`outMs`) + the 9:16 framing (`xOffset`) are required; the caption is
// optional (authored later via copywriting-fluncle), and `status` defaults to
// `pending` (the cut queue picks it up) but may be set explicitly.
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
    mixtapeId: row.mixtape_id,
    outMs: row.out_ms,
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

// A clip cut window must be ordered (out after in) — guard it once for create + update.
function assertWindow(inMs: number, outMs: number): void {
  if (outMs <= inMs) {
    throw new ApiError("invalid_window", "A clip's out point must be after its in point", 400);
  }
}

async function getClipRow(clipId: string): Promise<ClipRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [clipId],
    sql: `select id, mixtape_id, in_ms, out_ms, x_offset, caption, status, created_at, updated_at
          from mixtape_clips where id = ? limit 1`,
  });
  const row = typedRow<ClipRow>(result.rows);

  if (!row) {
    throw new ApiError("clip_not_found", "Clip not found", 404);
  }

  return row;
}

// Fetch one clip by id (a clean 404 when it's gone). Exported so the agent-tier cut
// ops (Unit C: `presign_clip_upload` / `finalize_clip_cut`) can confirm the clip
// exists before signing its upload / marking it done.
export async function getClip(clipId: string): Promise<ClipDTO> {
  return rowToClip(await getClipRow(clipId));
}

// Mark a clip's cut `done` (Unit C `finalize_clip_cut`). A thin wrapper over the
// shared `updateClip` so the box's agent-tier finalize and the operator `update_clip`
// write the SAME `status` column the same way.
export async function markClipCutDone(clipId: string): Promise<ClipDTO> {
  return updateClip(clipId, { status: "done" });
}

export async function createClip(mixtapeId: string, input: ClipInput): Promise<ClipDTO> {
  // The mixtape must exist (drafts included — pre-release backlog clipping stages
  // the set early). getMixtapeById throws `mixtape_not_found`/404 if it doesn't.
  await getMixtapeById(mixtapeId, { includeDrafts: true });

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
    args: [id, mixtapeId, inMs, outMs, xOffset, caption, status, now, now],
    sql: `insert into mixtape_clips
            (id, mixtape_id, in_ms, out_ms, x_offset, caption, status, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  return rowToClip(await getClipRow(id));
}

export async function updateClip(clipId: string, input: ClipInput): Promise<ClipDTO> {
  const current = await getClipRow(clipId);

  const inMs = optionalNonNegativeInteger(input.inMs, "inMs");
  const outMs = optionalNonNegativeInteger(input.outMs, "outMs");
  const xOffset = optionalNonNegativeInteger(input.xOffset, "xOffset");
  const caption = optionalCaption(input.caption);
  const status = optionalStatus(input.status);

  // Validate the resulting window (the field given, or the stored one it keeps).
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
  // Confirm it exists for a clean 404 (a delete on a missing clip is an error, not
  // a silent no-op — the operator expects the row to have been there).
  await getClipRow(clipId);

  const db = await getDb();
  await db.execute({ args: [clipId], sql: `delete from mixtape_clips where id = ?` });
}

// List clips, optionally narrowed by mixtape and/or status. Serves BOTH the per-set
// editor (Unit E, `mixtapeId` set) and the cross-set clip library (Unit G, all sets).
// Newest first, so the most recent cuts surface at the top of the library grid.
export async function listClips(
  filter: { mixtapeId?: string; status?: string } = {},
): Promise<ClipDTO[]> {
  const conditions: string[] = [];
  const args: string[] = [];

  if (filter.mixtapeId) {
    conditions.push("mixtape_id = ?");
    args.push(filter.mixtapeId);
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
    sql: `select id, mixtape_id, in_ms, out_ms, x_offset, caption, status, created_at, updated_at
          from mixtape_clips ${where} order by created_at desc, id desc`,
  });

  return typedRows<ClipRow>(result.rows).map(rowToClip);
}
