import { type Client } from "@libsql/client";

import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { getSetting } from "./settings";

export const CRAWL_PLAUSIBILITY_HOLD_ENABLED_KEY = "crawl_plausibility_hold_enabled";

export const FOUNDING_GAP_YEARS = 2;
export const LABEL_ERA_GAP_YEARS = 5;
export const LABEL_ERA_MIN_DATED_TRACKS = 20;
export const LABEL_ERA_FLOOR_DIVISOR = 10;
const MAX_CORROBORATING_ARTISTS = 100;
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

export async function labelEraFloorYear(
  client: ExecuteClient,
  labelId: string,
): Promise<null | number> {
  const result = await client.execute({
    args: [labelId],
    sql: `select
            (select count(*) from tracks where label_id = ?1 and release_date >= '1') as dated,
            (select release_date from tracks where label_id = ?1 and release_date >= '1'
             order by release_date asc limit 1
             offset (select count(*) / ${LABEL_ERA_FLOOR_DIVISOR} from tracks
                     where label_id = ?1 and release_date >= '1')) as floor_date`,
  });
  const row = typedRows<{ dated: number; floor_date: null | string }>(result.rows)[0];

  return Number(row?.dated ?? 0) < LABEL_ERA_MIN_DATED_TRACKS ? null : yearOf(row?.floor_date);
}

export async function creditedArtistStoredOnEnabledLabel(
  client: ExecuteClient,
  artistMbids: readonly string[],
): Promise<boolean> {
  const mbids = [...new Set(artistMbids)].slice(0, MAX_CORROBORATING_ARTISTS);

  if (mbids.length === 0) {
    return false;
  }

  const result = await client.execute({
    args: mbids,
    sql: `select 1 from artists
          join track_artists on track_artists.artist_id = artists.id
          join tracks on tracks.track_id = track_artists.track_id
          join labels on labels.id = tracks.label_id
          where artists.mbid in (${mbids.map(() => "?").join(", ")})
            and labels.seed_state = 'enabled'
          limit 1`,
  });

  return result.rows.length > 0;
}

const STORED_PROBE_CHUNK = 100;

type HoldPreRead = {
  prior: undefined | { reason: CrawlHoldReason; state: CrawlHoldState; thresholdYear: number };
  stored: boolean;
};

async function anyTrackStored(
  client: ExecuteClient,
  trackIds: readonly string[],
): Promise<boolean> {
  for (let index = 0; index < trackIds.length; index += STORED_PROBE_CHUNK) {
    const chunk = trackIds.slice(index, index + STORED_PROBE_CHUNK);
    const result = await client.execute({
      args: chunk,
      sql: `select 1 from tracks where track_id in (${chunk.map(() => "?").join(", ")}) limit 1`,
    });

    if (result.rows.length > 0) {
      return true;
    }
  }

  return false;
}

async function holdPreRead(
  client: ExecuteClient,
  releaseMbid: string,
  trackIds: readonly string[],
): Promise<HoldPreRead> {
  const ids = [...new Set(trackIds)];
  const head = ids.slice(0, STORED_PROBE_CHUNK);
  const storedProbe =
    head.length === 0
      ? "0"
      : `exists (select 1 from tracks where track_id in (${head.map(() => "?").join(", ")}))`;
  const result = await client.execute({
    args: [...head, releaseMbid],
    sql: `select ${storedProbe} as stored, hold.state, hold.reason, hold.threshold_year
          from (select 1) as probe
          left join crawl_release_holds as hold on hold.release_mbid = ?`,
  });
  const row = typedRows<{
    reason: CrawlHoldReason | null;
    state: CrawlHoldState | null;
    stored: number;
    threshold_year: null | number;
  }>(result.rows)[0];
  const prior =
    row?.state && row.reason
      ? { reason: row.reason, state: row.state, thresholdYear: Number(row.threshold_year ?? 0) }
      : undefined;
  const stored =
    Number(row?.stored ?? 0) === 1 || (await anyTrackStored(client, ids.slice(STORED_PROBE_CHUNK)));

  return { prior, stored };
}

async function existingHoldState(
  client: ExecuteClient,
  releaseMbid: string,
): Promise<CrawlHoldState | undefined> {
  const result = await client.execute({
    args: [releaseMbid],
    sql: `select state from crawl_release_holds where release_mbid = ?`,
  });

  return typedRows<{ state: CrawlHoldState }>(result.rows)[0]?.state;
}

export async function decideReleaseHold(
  client: ExecuteClient,
  input: {
    artistMbids: readonly string[];
    artistNames: readonly string[];
    foundingDate: null | string | undefined;
    labelId: string;
    releaseDate: null | string | undefined;
    releaseMbid: string;
    releaseTitle: null | string | undefined;
    trackIds: readonly string[];
  },
): Promise<ReleaseHoldDecision> {
  const { prior, stored } = await holdPreRead(client, input.releaseMbid, input.trackIds);

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

  if (releaseYear === null || stored) {
    return { kind: "store" };
  }

  const eraFloorYear =
    foundingYear === null ? await labelEraFloorYear(client, input.labelId) : null;
  const verdict = creditPlausibility({ eraFloorYear, foundingYear, releaseYear });

  if (verdict.kind === "plausible" || !(await isCrawlPlausibilityHoldEnabled())) {
    return { kind: "store" };
  }

  if (await creditedArtistStoredOnEnabledLabel(client, input.artistMbids)) {
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
      input.trackIds.length,
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

export async function listCrawlHolds(
  options: { limit?: number; state?: CrawlHoldState } = {},
  client?: ExecuteClient,
): Promise<{ holds: CrawlHold[]; total: number }> {
  const db = client ?? (await getDb());
  const state = options.state ?? "held";
  const limit = Math.max(
    1,
    Math.min(options.limit ?? CRAWL_HOLDS_PAGE_SIZE, CRAWL_HOLDS_PAGE_SIZE),
  );
  const [rows, counted] = await Promise.all([
    db.execute({
      args: [state, limit],
      sql: `select hold.release_mbid, hold.label_id, hold.release_title, hold.release_date,
                   hold.artists, hold.track_count, hold.reason, hold.threshold_year, hold.state,
                   hold.created_at, labels.name as label_name, labels.slug as label_slug
            from crawl_release_holds as hold
            left join labels on labels.id = hold.label_id
            where hold.state = ?
            order by hold.created_at asc, hold.release_mbid asc
            limit ?`,
    }),
    db.execute({
      args: [state],
      sql: `select count(*) as n from crawl_release_holds where state = ?`,
    }),
  ]);

  return {
    holds: typedRows<HoldRow>(rows.rows).map(toCrawlHold),
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
