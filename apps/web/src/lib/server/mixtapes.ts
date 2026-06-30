import { randomUUID } from "node:crypto";
import { type MixtapeDTO, type MixtapeStatus, rowToMixtape } from "../mixtapes";
import { getDb, typedRow, typedRows } from "./db";
import { purgeLogCache } from "./edge-cache";
import { mixtapeLogId } from "./mixtape-log-id";
import { ApiError } from "./spotify";
import { getTrackByIdOrLogId, getTracksForMixtape } from "./tracks";

// A mixtape is also a finding with a `/log/<F-id>` page (and a row in the `/log`
// index). Any write that changes its published surface must drop those from the
// edge cache. `purgeLogCache` no-ops on a draft (no coordinate yet), so it is safe
// to call after every member/metadata edit too.
function purgeMixtapeLogCache(mixtape: MixtapeDTO): MixtapeDTO {
  purgeLogCache(mixtape.logId);

  return mixtape;
}

const noteMaxLength = 1_200;
const urlMaxLength = 500;

// The title stub a draft carries until publish. Once the Log ID + sequence number
// exist, a stub title (empty or this default) is canonicalized to the real format;
// an operator-set title (a future custom series) is left untouched. The cover is
// derived from the Log ID, never stored. ("Untitled mixtape" is the legacy stub.)
export const DEFAULT_MIXTAPE_TITLE = "Fluncle Drum & Bass Mixtape";
const LEGACY_MIXTAPE_TITLE = "Untitled mixtape";

type MixtapeRow = {
  added_at: string | null;
  created_at: string;
  duration_ms: number | null;
  id: string;
  log_id: string | null;
  member_count: number | null;
  mixcloud_url: string | null;
  note: string | null;
  planned_for: string | null;
  published_at: string | null;
  recorded_at: string | null;
  sequence_number: number | null;
  set_video_at: string | null;
  soundcloud_url: string | null;
  status: MixtapeStatus;
  title: string;
  updated_at: string;
  youtube_url: string | null;
};

type PublishRow = {
  log_id: string;
  sequence_number: number;
};

type StatusRow = {
  status: MixtapeStatus;
};

// A draft is the operator-authored subset of a mixtape. The title (auto-set at
// publish) and cover (derived from the Log ID) are outputs, not inputs. YouTube +
// Mixcloud links are recorded by `distribute` (mixtape_social_posts), never set
// here; only the manual SoundCloud link is editable, and it too writes a
// mixtape_social_posts row (see setMixtapeSoundcloud).
export type MixtapeInput = {
  durationMs?: unknown;
  note?: unknown;
  plannedFor?: unknown;
  recordedAt?: unknown;
  setVideoAt?: unknown;
  soundcloudUrl?: unknown;
};

export type MixtapeMemberInput = {
  members?: Array<string | { ref: string; startMs?: number }>;
};

// A finding's membership in one mixtape — the spine link the admin board reads to
// mark which bangers are already spoken for (a published checkpoint) or pencilled
// into a draft. Keyed by trackId; a finding can sit in more than one.
export type MixtapeMembership = {
  logId?: string;
  mixtapeId: string;
  status: MixtapeStatus;
  title: string;
};

export async function createMixtape(input: MixtapeInput): Promise<MixtapeDTO> {
  const fields = validateMixtapeInput(input);
  const now = new Date().toISOString();
  const id = randomUUID();
  const db = await getDb();

  // Title is empty until publish canonicalizes it; the column stays NOT NULL (and
  // open for a future custom-series title), so seed it with an empty string.
  await db.execute({
    args: [
      id,
      "draft",
      "",
      fields.durationMs ?? null,
      fields.note ?? null,
      fields.recordedAt ?? null,
      fields.plannedFor ?? null,
      now,
      now,
    ],
    sql: `insert into mixtapes (
        id, status, title, duration_ms, note,
        recorded_at, planned_for, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  // A manual SoundCloud link given at creation becomes a published distribution row.
  if (fields.soundcloudUrl) {
    await setMixtapeSoundcloud(id, fields.soundcloudUrl);
  }

  return getMixtapeById(id, { includeDrafts: true });
}

export async function updateMixtape(id: string, input: MixtapeInput): Promise<MixtapeDTO> {
  // A published mixtape stays editable — the note, links, and duration can change
  // over time — but its minted coordinate freezes the recorded date the sector was
  // derived from. Drafts have no such limit. (Members stay draft-only; see
  // setMixtapeMembers. The YouTube/Mixcloud links live in mixtape_social_posts via
  // `distribute`; the manual SoundCloud link is handled below.)
  const current = await getMixtapeById(id, { includeDrafts: true });
  const fields = validateMixtapeInput(input);

  if (current.status === "published" && fields.recordedAt !== undefined) {
    throw new ApiError(
      "recorded_at_immutable",
      "The recorded date is locked once a mixtape is published",
      409,
    );
  }

  const sets: string[] = [];
  const args: Array<number | string | null> = [];

  for (const [column, value] of [
    ["duration_ms", fields.durationMs],
    ["note", fields.note],
    ["recorded_at", fields.recordedAt],
    ["planned_for", fields.plannedFor],
    ["set_video_at", fields.setVideoAt],
  ] as const) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      args.push(value ?? null);
    }
  }

  if (sets.length === 0 && fields.soundcloudUrl === undefined) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    args.push(new Date().toISOString(), id);

    const db = await getDb();
    await db.execute({
      args,
      sql: `update mixtapes set ${sets.join(", ")} where id = ?`,
    });
  }

  // The manual SoundCloud link is a distribution row, not a column; `null`/"" clears it.
  if (fields.soundcloudUrl !== undefined) {
    await setMixtapeSoundcloud(id, fields.soundcloudUrl);
  }

  return purgeMixtapeLogCache(await getMixtapeById(id, { includeDrafts: true }));
}

// The manual SoundCloud link as a `mixtape_social_posts` row (the single source of
// truth for listen links). A non-empty URL upserts a `published` row; null/"" removes
// it. Inlined here rather than calling mixtape-social to avoid an import cycle. Bumps
// the mixtape's updated_at — the link changes its public surface + cover cache key.
async function setMixtapeSoundcloud(mixtapeId: string, url: string | null): Promise<void> {
  const now = new Date().toISOString();
  const db = await getDb();

  if (url) {
    await db.execute({
      args: [randomUUID(), mixtapeId, url, now, now, now, url, now],
      sql: `insert into mixtape_social_posts (id, mixtape_id, platform, status, url, published_at, created_at, updated_at)
            values (?, ?, 'soundcloud', 'published', ?, ?, ?, ?)
            on conflict(mixtape_id, platform) do update set
              status = 'published',
              url = ?,
              published_at = coalesce(mixtape_social_posts.published_at, ?),
              updated_at = excluded.updated_at`,
    });
  } else {
    await db.execute({
      args: [mixtapeId],
      sql: `delete from mixtape_social_posts where mixtape_id = ? and platform = 'soundcloud'`,
    });
  }

  await db.execute({
    args: [now, mixtapeId],
    sql: `update mixtapes set updated_at = ? where id = ?`,
  });
}

export async function setMixtapeMembers(
  id: string,
  input: MixtapeMemberInput,
): Promise<MixtapeDTO> {
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new ApiError("invalid_members", "Add at least one finding to the mixtape", 400);
  }

  await assertDraftMixtape(id);

  const seen = new Set<string>();
  const entries: { startMs: number | null; trackId: string }[] = [];

  for (const raw of input.members) {
    const ref = typeof raw === "string" ? raw : raw?.ref;
    const startMs = typeof raw === "string" ? undefined : raw?.startMs;

    const value = requireText(ref, "member", 80);

    if (startMs !== undefined) {
      if (typeof startMs !== "number" || !Number.isInteger(startMs) || startMs < 0) {
        throw new ApiError(
          "invalid_start_ms",
          "Cue timestamps must be non-negative integers (ms)",
          400,
        );
      }
    }

    const track = await getTrackByIdOrLogId(value);

    if (!track) {
      throw new ApiError("member_not_found", `No finding with id ${value}`, 400);
    }

    if (seen.has(track.trackId)) {
      throw new ApiError("duplicate_member", "A finding can only appear once", 400);
    }

    seen.add(track.trackId);
    entries.push({ startMs: startMs ?? null, trackId: track.trackId });
  }

  const db = await getDb();
  await db.batch(
    [
      { args: [id], sql: `delete from mixtape_tracks where mixtape_id = ?` },
      ...entries.map((entry, index) => ({
        args: [id, entry.trackId, index + 1, entry.startMs],
        sql: `insert into mixtape_tracks (mixtape_id, track_id, position, start_ms) values (?, ?, ?, ?)`,
      })),
      {
        args: [new Date().toISOString(), id],
        sql: `update mixtapes set updated_at = ? where id = ?`,
      },
    ],
    "write",
  );

  return purgeMixtapeLogCache(await getMixtapeById(id, { includeDrafts: true }));
}

// Append findings to a draft's tracklist, keeping the existing order — the board's
// "Add to mixtape" path, where setMixtapeMembers (a full replace) would clobber the
// tracklist. Findings already in the tape, or repeated in the input, are skipped
// silently (a bulk add can overlap), so this is idempotent; a request resolving to
// no new findings is a no-op, not an error. Draft-only, like every member edit.
export async function addTracksToMixtape(
  id: string,
  input: MixtapeMemberInput,
): Promise<MixtapeDTO> {
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new ApiError("invalid_members", "Add at least one finding to the mixtape", 400);
  }

  await assertDraftMixtape(id);

  const db = await getDb();
  const existing = await db.execute({
    args: [id],
    sql: `select track_id, position from mixtape_tracks where mixtape_id = ?`,
  });
  const present = new Set(
    typedRows<{ position: number; track_id: string }>(existing.rows).map((row) => row.track_id),
  );
  let position = typedRows<{ position: number; track_id: string }>(existing.rows).reduce(
    (max, row) => Math.max(max, row.position),
    0,
  );

  const seen = new Set<string>();
  const inserts: { startMs: number | null; trackId: string }[] = [];

  for (const raw of input.members) {
    const ref = typeof raw === "string" ? raw : raw?.ref;
    const startMs = typeof raw === "string" ? undefined : raw?.startMs;
    const value = requireText(ref, "member", 80);

    if (startMs !== undefined) {
      if (typeof startMs !== "number" || !Number.isInteger(startMs) || startMs < 0) {
        throw new ApiError(
          "invalid_start_ms",
          "Cue timestamps must be non-negative integers (ms)",
          400,
        );
      }
    }

    const track = await getTrackByIdOrLogId(value);

    if (!track) {
      throw new ApiError("member_not_found", `No finding with id ${value}`, 400);
    }

    // Already in this tape, or a repeat within this request — skip it.
    if (present.has(track.trackId) || seen.has(track.trackId)) {
      continue;
    }

    seen.add(track.trackId);
    inserts.push({ startMs: startMs ?? null, trackId: track.trackId });
  }

  if (inserts.length > 0) {
    await db.batch(
      [
        ...inserts.map((entry) => {
          position += 1;
          return {
            args: [id, entry.trackId, position, entry.startMs],
            sql: `insert into mixtape_tracks (mixtape_id, track_id, position, start_ms) values (?, ?, ?, ?)`,
          };
        }),
        {
          args: [new Date().toISOString(), id],
          sql: `update mixtapes set updated_at = ? where id = ?`,
        },
      ],
      "write",
    );
  }

  return purgeMixtapeLogCache(await getMixtapeById(id, { includeDrafts: true }));
}

// A cue: a member's start offset on the set timeline, keyed by the member's TRACK
// ID (`ref`), matching the `(mixtape_id, track_id)` unique index. The Fluncle Studio
// cue-backfill body.
export type MixtapeCueInput = {
  cues?: Array<{ ref?: unknown; startMs?: unknown }>;
};

// Backfill a MINTED mixtape's per-track cues (`mixtape_tracks.start_ms`) — the
// narrow, HARDENED write-path that unlocks #1's missing cues post-publish without
// touching the frozen set/order. Unlike
// the draft member edits (setMixtapeMembers), this does NOT call assertDraftMixtape;
// instead it is the inverse — it asserts the mixtape exists + is NON-draft, then
// re-times the EXISTING members only. Its guards (each a state backstop, not handler
// discipline):
//   - the mixtape must exist + be non-draft (cues are a post-publish backfill);
//   - every `ref` must be a CURRENT member, and the cue set must match the member set
//     EXACTLY (same count + same trackId set) — so it can only re-time the frozen
//     tracklist, never add/drop/reorder it (rejects a non-member ref);
//   - the cues, in tracklist order, must start at 0 and increase monotonically
//     (YouTube chapter rules).
// It backfills the DB + `/mixtapes`, but NOT the already-distributed YouTube
// description chapters (a chapters re-push is out of scope; M2).
export async function setMixtapeCues(id: string, input: MixtapeCueInput): Promise<MixtapeDTO> {
  if (!Array.isArray(input.cues) || input.cues.length === 0) {
    throw new ApiError("invalid_cues", "Provide a cue for every track", 400);
  }

  // Assert the mixtape exists (getMixtapeById throws mixtape_not_found/404) and is
  // NON-draft — cues backfill a published/distributing set, never a draft (draft
  // start_ms is owned by setMixtapeMembers on the draft path).
  const mixtape = await getMixtapeById(id, { includeDrafts: true });

  if (mixtape.status === "draft") {
    throw new ApiError(
      "mixtape_is_draft",
      "Cues backfill a minted set — publish the mixtape first",
      409,
    );
  }

  // Validate each cue's shape: a non-empty `ref` (trackId) + a non-negative integer
  // `startMs`, no duplicate refs.
  const byRef = new Map<string, number>();

  for (const raw of input.cues) {
    const ref = typeof raw?.ref === "string" ? raw.ref.trim() : "";
    const startMs = raw?.startMs;

    if (!ref) {
      throw new ApiError("invalid_cues", "Each cue needs a track ref", 400);
    }

    if (typeof startMs !== "number" || !Number.isInteger(startMs) || startMs < 0) {
      throw new ApiError(
        "invalid_start_ms",
        "Cue timestamps must be non-negative integers (ms)",
        400,
      );
    }

    if (byRef.has(ref)) {
      throw new ApiError("duplicate_cue", "A track can only carry one cue", 400);
    }

    byRef.set(ref, startMs);
  }

  // Load the current members in tracklist order. The cue set must match this member
  // set EXACTLY — the state backstop that keeps this from altering the tracklist.
  const db = await getDb();
  const membersResult = await db.execute({
    args: [id],
    sql: `select track_id, position from mixtape_tracks where mixtape_id = ? order by position`,
  });
  const members = typedRows<{ position: number; track_id: string }>(membersResult.rows);

  if (members.length !== byRef.size) {
    throw new ApiError(
      "member_set_changed",
      "Cues must cover exactly the current tracklist (one per track)",
      409,
    );
  }

  // Reject any ref that isn't a current member. With equal counts + unique refs,
  // every ref matching a member means the two sets are identical.
  for (const ref of byRef.keys()) {
    if (!members.some((member) => member.track_id === ref)) {
      throw new ApiError("non_member_cue", `No current member with id ${ref}`, 400);
    }
  }

  // Validate monotonic, start-at-0 cues along the tracklist order (YouTube chapters).
  let previous = -1;

  for (const [index, member] of members.entries()) {
    const startMs = byRef.get(member.track_id) ?? 0;

    if (index === 0 && startMs !== 0) {
      throw new ApiError("cue_not_start_at_zero", "The first cue must start at 0 ms", 400);
    }

    if (startMs <= previous) {
      throw new ApiError(
        "cue_not_monotonic",
        "Cues must increase along the tracklist (no repeats, in order)",
        400,
      );
    }

    previous = startMs;
  }

  // Re-time the existing members only — one UPDATE per member, plus the mixtape's
  // updated_at bump (the cues change its public /mixtapes surface).
  const now = new Date().toISOString();
  await db.batch(
    [
      ...members.map((member) => ({
        args: [byRef.get(member.track_id) ?? 0, id, member.track_id],
        sql: `update mixtape_tracks set start_ms = ? where mixtape_id = ? and track_id = ?`,
      })),
      { args: [now, id], sql: `update mixtapes set updated_at = ? where id = ?` },
    ],
    "write",
  );

  return purgeMixtapeLogCache(await getMixtapeById(id, { includeDrafts: true }));
}

// Which mixtapes each of these findings sits in, keyed by trackId — one query, no
// N+1, mirroring listSocialPostsForTracks. The board reads this for a page of
// findings to mark what's already spoken for; a finding in no mixtape is absent.
export async function listMixtapeMembershipsForTracks(
  trackIds: string[],
): Promise<Record<string, MixtapeMembership[]>> {
  if (trackIds.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select mt.track_id, m.id as mixtape_id, m.log_id, m.title, m.status
          from mixtape_tracks mt
          join mixtapes m on m.id = mt.mixtape_id
          where mt.track_id in (${placeholders})
          order by m.sequence_number, m.created_at`,
  });

  const byTrack: Record<string, MixtapeMembership[]> = {};

  for (const row of typedRows<{
    log_id: string | null;
    mixtape_id: string;
    status: MixtapeStatus;
    title: string;
    track_id: string;
  }>(result.rows)) {
    (byTrack[row.track_id] ??= []).push({
      logId: row.log_id ?? undefined,
      mixtapeId: row.mixtape_id,
      status: row.status,
      title: row.title,
    });
  }

  return byTrack;
}

// Mint a draft into the spine: commit its sequence number, Log ID, and canonical
// title, moving it from `draft` to `distributing`. This is the FIRST half of
// publishing — the coordinate now exists (so the cover endpoint and the platform
// assets can embed the real Log ID), but the mixtape is NOT yet public. It becomes
// `published` only when the first platform link lands (finalizeMixtapeDistribution),
// which supplies the listen link — there is no link requirement to mint.
export async function publishMixtape(id: string): Promise<MixtapeDTO> {
  const draft = await getMixtapeById(id, { includeDrafts: true });

  if (draft.status === "published") {
    throw new ApiError("already_published", "Published mixtapes keep their coordinate", 409);
  }
  if (draft.status === "distributing") {
    throw new ApiError(
      "already_minted",
      "This mixtape already has its coordinate — distribution is in progress",
      409,
    );
  }

  // A draft is just the tracklist — that's the only hard requirement to mint. The
  // recorded date defaults to today (set it on the draft only to backdate the
  // coordinate's sector); the dream note is written later via the post-publish edit;
  // the duration is derived from the upload by `distribute`. Title + Log ID + cover
  // are minted/derived here.
  if (draft.memberCount < 1) {
    throw new ApiError("missing_members", "Add at least one finding before publishing", 409);
  }

  // Fail before any upload starts if the spine is full (54 = 9 sectors × 6 letters).
  // The mint CTE re-checks this atomically; this is the early, legible error.
  if ((await nextMixtapeSequence()) > 54) {
    throw new ApiError("mixtape_cap_reached", "The mixtape spine is full (54)", 409);
  }

  const recordedAt = draft.recordedAt ?? new Date().toISOString();
  const sectorPrefix = mixtapeLogId(recordedAt, 1).slice(0, -2);
  const now = new Date().toISOString();
  const db = await getDb();
  const [publishResult] = await db.batch(
    [
      {
        args: [sectorPrefix, recordedAt, now, now, id],
        sql: `with next_sequence(n) as (
                select coalesce(max(sequence_number), 0) + 1
                from mixtapes
                where sequence_number is not null
              )
              update mixtapes
              set
                sequence_number = (select n from next_sequence),
                log_id = ? || cast(((select n from next_sequence) - 1) / 6 + 1 as integer)
                  || substr('ABCDEF', ((select n from next_sequence) - 1) % 6 + 1, 1),
                status = 'distributing',
                recorded_at = ?,
                added_at = ?,
                updated_at = ?
              where id = ?
                and status = 'draft'
                and (select n from next_sequence) <= 54
              returning log_id, sequence_number`,
      },
    ],
    "write",
  );

  if (publishResult === undefined) {
    throw new ApiError("publish_failed", "Mixtape could not be minted", 409);
  }

  const row = typedRow<PublishRow>(publishResult.rows);

  if (!row) {
    throw new ApiError("publish_failed", "Mixtape could not be minted", 409);
  }

  // The Log ID and sequence number only exist now — canonicalize the title from
  // them. A title an operator set (a future custom series) is left untouched; the
  // empty/stub title every draft carries today gets the standard format.
  const currentTitle = draft.title.trim();
  const isStub =
    currentTitle === "" ||
    currentTitle === DEFAULT_MIXTAPE_TITLE ||
    currentTitle === LEGACY_MIXTAPE_TITLE;

  if (isStub) {
    await db.execute({
      args: [`Fluncle Drum & Bass Mixtape #${row.sequence_number} | ${row.log_id}`, now, id],
      sql: `update mixtapes set title = ?, updated_at = ? where id = ?`,
    });
  }

  // Read back through the draft-inclusive path: the row is `distributing` now, so
  // getMixtapeByLogId (published-only) would not return it. The coordinate now
  // exists, so its `/log` page + the index need to re-render.
  return purgeMixtapeLogCache(await getMixtapeById(id, { includeDrafts: true }));
}

export async function deleteMixtape(id: string): Promise<void> {
  const mixtape = await getMixtapeById(id, { includeDrafts: true });

  if (mixtape.status !== "draft") {
    throw new ApiError(
      "published_not_deletable",
      "A minted mixtape keeps its coordinate and can't be deleted",
      409,
    );
  }

  const db = await getDb();
  await db.batch(
    [
      { args: [id], sql: `delete from mixtape_tracks where mixtape_id = ?` },
      { args: [id], sql: `delete from mixtapes where id = ?` },
    ],
    "write",
  );
}

export async function getMixtapeByLogId(logId: string): Promise<MixtapeDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [logId],
    sql: `${MIXTAPE_SELECT} where m.log_id = ? and m.status = 'published' limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  return row ? hydrateMixtape(row) : undefined;
}

/**
 * A mixtape for ASSET RENDERING (the on-the-fly cover endpoint). Unlike
 * getMixtapeByLogId (published-only — the public read), this also admits a
 * `distributing` mixtape: its coordinate is committed and the cover must render
 * while the platform uploads run. NEVER use this for a public surface — a
 * distributing mixtape has no live link yet.
 */
export async function getMixtapeForRender(logId: string): Promise<MixtapeDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [logId],
    sql: `${MIXTAPE_SELECT} where m.log_id = ? and m.status in ('published', 'distributing') limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  return row ? hydrateMixtape(row) : undefined;
}

// The sequence number the next mint will claim (1-based). Used for the cap
// pre-check before publish; the mint CTE re-derives this atomically.
async function nextMixtapeSequence(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select coalesce(max(sequence_number), 0) + 1 as n
          from mixtapes where sequence_number is not null`,
  });
  const row = typedRow<{ n: number }>(result.rows);

  return Number(row?.n ?? 1);
}

export async function getMixtapeById(
  id: string,
  options: { includeDrafts?: boolean } = {},
): Promise<MixtapeDTO> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `${MIXTAPE_SELECT} where m.id = ? ${options.includeDrafts ? "" : "and m.status = 'published'"} limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  if (!row) {
    throw new ApiError("mixtape_not_found", "Mixtape not found", 404);
  }

  return hydrateMixtape(row);
}

export async function listMixtapes({
  hydrateMembers = false,
  includeDrafts = false,
  limit = 54,
}: {
  hydrateMembers?: boolean;
  includeDrafts?: boolean;
  limit?: number;
} = {}): Promise<MixtapeDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 54)],
    sql: `${MIXTAPE_SELECT}
          ${includeDrafts ? "" : "where m.status = 'published'"}
          order by coalesce(m.added_at, m.created_at) desc, m.id desc
          limit ?`,
  });

  const rows = typedRows<MixtapeRow>(result.rows);

  return hydrateMembers
    ? Promise.all(rows.map(hydrateMixtape))
    : rows.map((row) => rowToMixtape(row));
}

/**
 * The mixtapes the subscribe-able /calendar.ics surfaces:
 *   - every `published` mixtape (a past event, dated by recorded_at), and
 *   - any mixtape with a FUTURE `planned_for` — including drafts, which is the
 *     intended teaser: an upcoming live session announced before it's recorded.
 *
 * A draft WITHOUT `planned_for` stays fully hidden (it's neither published nor
 * future-planned), so the calendar never leaks unannounced drafts. Members are
 * hydrated so the .ics description can carry the tracklist.
 */
export async function listCalendarMixtapes(nowIso: string): Promise<MixtapeDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [nowIso],
    sql: `${MIXTAPE_SELECT}
          where m.status = 'published'
             or (m.planned_for is not null and m.planned_for > ?)
          order by coalesce(m.planned_for, m.recorded_at, m.added_at, m.created_at) asc, m.id asc
          limit 108`,
  });

  const rows = typedRows<MixtapeRow>(result.rows);

  return Promise.all(rows.map(hydrateMixtape));
}

const MIXTAPE_SELECT = `select
  m.id,
  m.status,
  m.log_id,
  m.sequence_number,
  m.title,
  m.duration_ms,
  m.note,
  (select url from mixtape_social_posts s
     where s.mixtape_id = m.id and s.platform = 'mixcloud' and s.status = 'published' and s.url is not null
     order by published_at desc limit 1) as mixcloud_url,
  (select url from mixtape_social_posts s
     where s.mixtape_id = m.id and s.platform = 'youtube' and s.status = 'published' and s.url is not null
     order by published_at desc limit 1) as youtube_url,
  (select url from mixtape_social_posts s
     where s.mixtape_id = m.id and s.platform = 'soundcloud' and s.status = 'published' and s.url is not null
     order by published_at desc limit 1) as soundcloud_url,
  m.added_at,
  m.recorded_at,
  m.planned_for,
  m.published_at,
  m.set_video_at,
  m.created_at,
  m.updated_at,
  (select count(*) from mixtape_tracks mt where mt.mixtape_id = m.id) as member_count
  from mixtapes m`;

async function hydrateMixtape(row: MixtapeRow): Promise<MixtapeDTO> {
  return rowToMixtape(row, await getTracksForMixtape(row.id));
}

async function assertDraftMixtape(id: string): Promise<void> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select status from mixtapes where id = ? limit 1`,
  });
  const row = typedRow<StatusRow>(result.rows);

  if (!row) {
    throw new ApiError("mixtape_not_found", "Mixtape not found", 404);
  }

  if (row.status !== "draft") {
    throw new ApiError(
      "published_immutable",
      "Published mixtapes keep their checkpoint fixed",
      409,
    );
  }
}

function validateMixtapeInput(input: MixtapeInput): {
  durationMs?: number | null;
  note?: string | null;
  plannedFor?: string | null;
  recordedAt?: string | null;
  setVideoAt?: string | null;
  soundcloudUrl?: string | null;
} {
  return {
    durationMs: optionalInteger(input.durationMs, "durationMs"),
    note: optionalText(input.note, noteMaxLength),
    plannedFor: optionalIsoDate(input.plannedFor, "plannedFor"),
    recordedAt: optionalIsoDate(input.recordedAt, "recordedAt"),
    setVideoAt: optionalIsoDate(input.setVideoAt, "setVideoAt"),
    soundcloudUrl: optionalUrl(input.soundcloudUrl),
  };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_input", `${field} is required`, 400);
  }

  return value.trim().slice(0, maxLength);
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

function optionalInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    throw new ApiError("invalid_input", `${field} must be a non-negative integer`, 400);
  }

  const number = typeof value === "number" ? value : Number.parseInt(value, 10);

  if (!Number.isInteger(number) || number < 0) {
    throw new ApiError("invalid_input", `${field} must be a non-negative integer`, 400);
  }

  return number;
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

function optionalUrl(value: unknown): string | null | undefined {
  const text = optionalText(value, urlMaxLength);

  if (text === undefined || text === null) {
    return text;
  }

  try {
    const url = new URL(text);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    throw new ApiError("invalid_url", "External links must be valid http(s) URLs", 400);
  }

  return text;
}
