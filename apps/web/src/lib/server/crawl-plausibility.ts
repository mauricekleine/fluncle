import { type Client } from "@libsql/client";

import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { getSetting } from "./settings";

export const CRAWL_PLAUSIBILITY_HOLD_ENABLED_KEY = "crawl_plausibility_hold_enabled";

export const FOUNDING_GAP_YEARS = 2;
export const LABEL_ERA_GAP_YEARS = 5;
export const LABEL_ERA_MIN_DATED_TRACKS = 20;
export const LABEL_ERA_FLOOR_DIVISOR = 10;
const ARTIST_PROBE_CHUNK = 100;
const LABEL_ERA_CACHE_TTL_MS = 60 * 60 * 1000;
const LABEL_ERA_CACHE_MAX_LABELS = 5000;
export const CRAWL_HOLDS_PAGE_SIZE = 100;

export type CrawlHoldReason = "before_founding" | "before_label_era";
export type CrawlHoldState = "held" | "kept_out" | "released";

export type CreditPlausibility =
  | { kind: "plausible" }
  | {
      kind: "implausible";
      reason: CrawlHoldReason;
      releaseYear: number;
      thresholdYear: number;
    };

export type ReleaseHoldDecision =
  | { kind: "store" }
  | { kind: "hold"; reason: CrawlHoldReason; recorded: boolean; thresholdYear: number };

export type CrawlHold = {
  artists: string[];
  createdAt: string;
  labelId: string;
  labelName: null | string;
  labelSlug: null | string;
  reason: CrawlHoldReason;
  releaseDate: null | string;
  releaseMbid: string;
  releaseTitle: null | string;
  state: CrawlHoldState;
  thresholdYear: number;
  trackCount: number;
};

type ExecuteClient = Pick<Client, "execute">;

export class CrawlHoldNotFoundError extends Error {
  constructor(releaseMbid: string) {
    super(`No held release ${releaseMbid}`);
    this.name = "CrawlHoldNotFoundError";
  }
}

export class CrawlHoldAlreadyReleasedError extends Error {
  constructor(releaseMbid: string) {
    super(`Already released to the crawl (${releaseMbid})`);
    this.name = "CrawlHoldAlreadyReleasedError";
  }
}

export async function isCrawlPlausibilityHoldEnabled(): Promise<boolean> {
  try {
    return (await getSetting(CRAWL_PLAUSIBILITY_HOLD_ENABLED_KEY)) !== "false";
  } catch {
    return true;
  }
}

export function yearOf(date: null | string | undefined): null | number {
  const match = /^(\d{4})/.exec(date ?? "");

  return match ? Number(match[1]) : null;
}

export function creditPlausibility(input: {
  eraFloorYear: null | number;
  foundingYear: null | number;
  releaseYear: null | number;
}): CreditPlausibility {
  const { eraFloorYear, foundingYear, releaseYear } = input;

  if (releaseYear === null) {
    return { kind: "plausible" };
  }

  if (foundingYear !== null) {
    return releaseYear <= foundingYear - FOUNDING_GAP_YEARS
      ? { kind: "implausible", reason: "before_founding", releaseYear, thresholdYear: foundingYear }
      : { kind: "plausible" };
  }

  if (eraFloorYear !== null && releaseYear <= eraFloorYear - LABEL_ERA_GAP_YEARS) {
    return {
      kind: "implausible",
      reason: "before_label_era",
      releaseYear,
      thresholdYear: eraFloorYear,
    };
  }

  return { kind: "plausible" };
}

const labelEraCache = new Map<string, { at: number; floor: null | number }>();

export function resetLabelEraCacheForTests(): void {
  labelEraCache.clear();
}

async function readLabelEraFloorYear(
  client: ExecuteClient,
  labelId: string,
): Promise<null | number> {
  const counted = await client.execute({
    args: [labelId],
    sql: `select count(*) as dated from tracks where label_id = ? and release_date >= '1'`,
  });
  const dated = Number(typedRows<{ dated: number }>(counted.rows)[0]?.dated ?? 0);

  if (dated < LABEL_ERA_MIN_DATED_TRACKS) {
    return null;
  }

  const floor = await client.execute({
    args: [labelId, Math.floor(dated / LABEL_ERA_FLOOR_DIVISOR)],
    sql: `select release_date from tracks where label_id = ? and release_date >= '1'
          order by release_date asc limit 1 offset ?`,
  });

  return yearOf(typedRows<{ release_date: null | string }>(floor.rows)[0]?.release_date);
}

export async function labelEraFloorYear(
  client: ExecuteClient,
  labelId: string,
  now: number = Date.now(),
): Promise<null | number> {
  const cached = labelEraCache.get(labelId);

  if (cached && now - cached.at < LABEL_ERA_CACHE_TTL_MS) {
    return cached.floor;
  }

  const floor = await readLabelEraFloorYear(client, labelId);

  if (labelEraCache.size >= LABEL_ERA_CACHE_MAX_LABELS) {
    labelEraCache.clear();
  }

  labelEraCache.set(labelId, { at: now, floor });

  return floor;
}

export async function creditedArtistStoredOnEnabledLabel(
  client: ExecuteClient,
  artistMbids: readonly string[],
): Promise<boolean> {
  const mbids = [...new Set(artistMbids)];

  for (let index = 0; index < mbids.length; index += ARTIST_PROBE_CHUNK) {
    const chunk = mbids.slice(index, index + ARTIST_PROBE_CHUNK);
    const result = await client.execute({
      args: chunk,
      sql: `select 1 from artists
            join track_artists on track_artists.artist_id = artists.id
            join tracks on tracks.track_id = track_artists.track_id
            join labels on labels.id = tracks.label_id
            where artists.mbid in (${chunk.map(() => "?").join(", ")})
              and labels.seed_state = 'enabled'
            limit 1`,
    });

    if (result.rows.length > 0) {
      return true;
    }
  }

  return false;
}

const STORED_PROBE_CHUNK = 100;

export type ReleaseRecording = { isrc: null | string; recordingId: string };

type StoredProbe = { args: (null | string)[]; sql: string };

function storedProbeChunks(recordings: readonly ReleaseRecording[]): StoredProbe[] {
  const recordingIds = [...new Set(recordings.map((recording) => recording.recordingId))];
  const isrcs = [
    ...new Set(
      recordings.flatMap((recording) =>
        recording.isrc ? [recording.isrc, recording.isrc.toUpperCase()] : [],
      ),
    ),
  ];
  const chunks: StoredProbe[] = [];

  for (let index = 0; index < recordingIds.length; index += STORED_PROBE_CHUNK) {
    const chunk = recordingIds.slice(index, index + STORED_PROBE_CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    chunks.push({
      args: [...chunk.map((id) => `mb_${id}`), ...chunk],
      sql: `exists (select 1 from tracks where track_id in (${marks}))
            or exists (select 1 from tracks where mb_recording_id in (${marks}))`,
    });
  }

  for (let index = 0; index < isrcs.length; index += STORED_PROBE_CHUNK) {
    const chunk = isrcs.slice(index, index + STORED_PROBE_CHUNK);
    chunks.push({
      args: chunk,
      sql: `exists (select 1 from tracks where isrc in (${chunk.map(() => "?").join(", ")}))`,
    });
  }

  return chunks;
}

type PriorHold = { reason: CrawlHoldReason; state: CrawlHoldState; thresholdYear: number };

async function priorHold(
  client: ExecuteClient,
  releaseMbid: string,
): Promise<PriorHold | undefined> {
  const result = await client.execute({
    args: [releaseMbid],
    sql: `select state, reason, threshold_year from crawl_release_holds where release_mbid = ?`,
  });
  const row = typedRows<{ reason: CrawlHoldReason; state: CrawlHoldState; threshold_year: number }>(
    result.rows,
  )[0];

  return row
    ? { reason: row.reason, state: row.state, thresholdYear: Number(row.threshold_year) }
    : undefined;
}

async function releaseAlreadyStored(
  client: ExecuteClient,
  input: {
    labelId: string;
    recordings: readonly ReleaseRecording[];
    releaseGroupMbid: null | string;
  },
): Promise<boolean> {
  const probes = storedProbeChunks(input.recordings);

  if (input.releaseGroupMbid) {
    probes.unshift({
      args: [input.labelId, input.releaseGroupMbid],
      sql: `exists (select 1 from tracks
                    where label_id = ?
                      and album_id = (select id from albums where release_group_mbid = ?))`,
    });
  }

  for (const probe of probes) {
    const result = await client.execute({ args: probe.args, sql: `select ${probe.sql} as stored` });

    if (Number(typedRows<{ stored: number }>(result.rows)[0]?.stored ?? 0) === 1) {
      return true;
    }
  }

  return false;
}

async function existingHoldState(
  client: ExecuteClient,
  releaseMbid: string,
): Promise<CrawlHoldState | undefined> {
  return (await priorHold(client, releaseMbid))?.state;
}

export async function decideReleaseHold(
  client: ExecuteClient,
  input: {
    artistMbids: readonly string[];
    artistNames: readonly string[];
    foundingDate: null | string | undefined;
    labelId: string;
    recordings: readonly ReleaseRecording[];
    releaseDate: null | string | undefined;
    releaseGroupMbid: null | string;
    releaseMbid: string;
    releaseTitle: null | string | undefined;
    trackCount: number;
  },
): Promise<ReleaseHoldDecision> {
  const prior = await priorHold(client, input.releaseMbid);

  if (prior?.state === "released") {
    return { kind: "store" };
  }

  if (prior) {
    return {
      kind: "hold",
      reason: prior.reason,
      recorded: false,
      thresholdYear: prior.thresholdYear,
    };
  }

  const releaseYear = yearOf(input.releaseDate);
  const foundingYear = yearOf(input.foundingDate);

  if (releaseYear === null || !(await isCrawlPlausibilityHoldEnabled())) {
    return { kind: "store" };
  }

  if (foundingYear !== null && releaseYear > foundingYear - FOUNDING_GAP_YEARS) {
    return { kind: "store" };
  }

  const eraFloorYear =
    foundingYear === null ? await labelEraFloorYear(client, input.labelId) : null;
  const verdict = creditPlausibility({ eraFloorYear, foundingYear, releaseYear });

  if (verdict.kind === "plausible") {
    return { kind: "store" };
  }

  if (
    (await releaseAlreadyStored(client, input)) ||
    (await creditedArtistStoredOnEnabledLabel(client, input.artistMbids))
  ) {
    return { kind: "store" };
  }

  const now = new Date().toISOString();
  await client.execute({
    args: [
      input.releaseMbid,
      input.labelId,
      input.releaseTitle ?? null,
      input.releaseDate ?? null,
      JSON.stringify([...new Set(input.artistNames)]),
      input.trackCount,
      verdict.reason,
      verdict.thresholdYear,
      now,
      now,
    ],
    sql: `insert into crawl_release_holds
            (release_mbid, label_id, release_title, release_date, artists, track_count, reason,
             threshold_year, state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)
          on conflict (release_mbid) do nothing`,
  });

  logEvent("info", "crawl.release-held", {
    labelId: input.labelId,
    reason: verdict.reason,
    release: input.releaseMbid,
    releaseYear: verdict.releaseYear,
    thresholdYear: verdict.thresholdYear,
  });

  return {
    kind: "hold",
    reason: verdict.reason,
    recorded: true,
    thresholdYear: verdict.thresholdYear,
  };
}

type HoldRow = {
  artists: string;
  created_at: string;
  label_id: string;
  label_name: null | string;
  label_slug: null | string;
  reason: CrawlHoldReason;
  release_date: null | string;
  release_mbid: string;
  release_title: null | string;
  state: CrawlHoldState;
  threshold_year: number;
  track_count: number;
};

function parseArtists(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function toCrawlHold(row: HoldRow): CrawlHold {
  return {
    artists: parseArtists(row.artists),
    createdAt: row.created_at,
    labelId: row.label_id,
    labelName: row.label_name,
    labelSlug: row.label_slug,
    reason: row.reason,
    releaseDate: row.release_date,
    releaseMbid: row.release_mbid,
    releaseTitle: row.release_title,
    state: row.state,
    thresholdYear: Number(row.threshold_year),
    trackCount: Number(row.track_count),
  };
}

export class CrawlHoldCursorError extends Error {
  constructor() {
    super("Invalid held-release cursor");
    this.name = "CrawlHoldCursorError";
  }
}

function encodeHoldCursor(hold: CrawlHold): string {
  return Buffer.from(JSON.stringify([hold.createdAt, hold.releaseMbid])).toString("base64url");
}

function decodeHoldCursor(cursor: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    throw new CrawlHoldCursorError();
  }

  throw new CrawlHoldCursorError();
}

export type CrawlHoldsPage = { holds: CrawlHold[]; nextCursor?: string; total: number };

export async function listCrawlHolds(
  options: { cursor?: string; limit?: number; state?: CrawlHoldState } = {},
  client?: ExecuteClient,
): Promise<CrawlHoldsPage> {
  const db = client ?? (await getDb());
  const state = options.state ?? "held";
  const limit = Math.max(
    1,
    Math.min(options.limit ?? CRAWL_HOLDS_PAGE_SIZE, CRAWL_HOLDS_PAGE_SIZE),
  );
  const after = options.cursor ? decodeHoldCursor(options.cursor) : undefined;
  const [rows, counted] = await Promise.all([
    db.execute({
      args: after ? [state, after[0], after[1], limit + 1] : [state, limit + 1],
      sql: `select hold.release_mbid, hold.label_id, hold.release_title, hold.release_date,
                   hold.artists, hold.track_count, hold.reason, hold.threshold_year, hold.state,
                   hold.created_at, labels.name as label_name, labels.slug as label_slug
            from crawl_release_holds as hold
            left join labels on labels.id = hold.label_id
            where hold.state = ?
              ${after ? "and (hold.created_at, hold.release_mbid) > (?, ?)" : ""}
            order by hold.created_at asc, hold.release_mbid asc
            limit ?`,
    }),
    db.execute({
      args: [state],
      sql: `select count(*) as n from crawl_release_holds where state = ?`,
    }),
  ]);
  const page = typedRows<HoldRow>(rows.rows).map(toCrawlHold);
  const holds = page.slice(0, limit);
  const last = holds.at(-1);

  return {
    holds,
    ...(page.length > limit && last ? { nextCursor: encodeHoldCursor(last) } : {}),
    total: Number(typedRows<{ n: number }>(counted.rows)[0]?.n ?? 0),
  };
}

export async function resolveCrawlHold(
  releaseMbid: string,
  decision: "keep_out" | "store",
): Promise<{ state: CrawlHoldState }> {
  const db = await getDb();
  const state: CrawlHoldState = decision === "store" ? "released" : "kept_out";
  const now = new Date().toISOString();
  const result = await db.execute({
    args: [state, now, now, releaseMbid],
    sql: `update crawl_release_holds
          set state = ?, ruled_at = ?, updated_at = ?, rearmed_at = null
          where release_mbid = ? and state in ('held', 'kept_out')`,
  });

  if (result.rowsAffected === 0) {
    if ((await existingHoldState(db, releaseMbid)) === "released") {
      throw new CrawlHoldAlreadyReleasedError(releaseMbid);
    }

    throw new CrawlHoldNotFoundError(releaseMbid);
  }

  logEvent("info", "crawl.hold-resolved", { decision, release: releaseMbid });

  return { state };
}

export const CRAWL_HOLD_REVIEW_LIMIT = 50;

export async function listCrawlHoldReviewRows(): Promise<
  { anchorAt: string; labelName: null | string; releaseMbid: string; releaseTitle: null | string }[]
> {
  const db = await getDb();
  const result = await db.execute({
    args: [CRAWL_HOLD_REVIEW_LIMIT],
    sql: `select hold.release_mbid, hold.release_title, hold.created_at, labels.name as label_name
          from crawl_release_holds as hold
          left join labels on labels.id = hold.label_id
          where hold.state = 'held'
          order by hold.created_at asc
          limit ?`,
  });

  return typedRows<{
    created_at: string;
    label_name: null | string;
    release_mbid: string;
    release_title: null | string;
  }>(result.rows).map((row) => ({
    anchorAt: row.created_at,
    labelName: row.label_name,
    releaseMbid: row.release_mbid,
    releaseTitle: row.release_title,
  }));
}
