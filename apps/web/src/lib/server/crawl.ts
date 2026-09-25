import {
  CRAWL_COMMIT_BATCH_MAX_TOTAL_BYTES,
  MAX_CRAWL_COMMIT_BATCH,
  MAX_CRAWL_PREPARE_LIMIT,
} from "@fluncle/contracts/orpc";
import { type Client, type InStatement } from "@libsql/client";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ensureAlbum } from "./albums";
import { linkTracksToArtistEntities, stampRemixerRoles } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import {
  CRAWL_STALE_ARTIST_REARM_LIMIT,
  crawlRankLabelSlugSql,
  MAX_CRAWL_DUE_CHUNK_SIZE,
  markCrawlNodeRepairStatement,
  markCrawlNodeRepairsByUpdatedAtStatement,
  markCrawlProjectionRepairStatement,
} from "./crawl-due-work";
import { currentSeedRearmBoundary } from "./crawl-rearm-schedule";
import {
  CRAWL_CATALOGUE_CLAIM_OWNER,
  CRAWL_CATALOGUE_LEASE_MS,
  CRAWL_CLAIM_REPAIR_DRAIN_BUDGET,
  CRAWL_CLAIM_SOURCE_MARKER_DRAIN_CAPACITY,
  type ClaimedCrawlFrontierRow,
  claimCrawlFrontierRows,
  isClaimedCrawlFrontierRowCurrent,
  isCrawlBoxFetchEnabled,
  isCrawlDueCutoverEnabled,
  settleClaimedCrawlFrontierRow,
} from "./crawl-cutover";
import { getDb, typedRows } from "./db";
import { parseDiscogsUrl } from "./discogs";
import {
  batchDueWorkSourceMutation,
  batchDueWorkMutationGroups,
  dueWorkSourceMutationStatements,
  MAX_DUE_WORK_CHUNK_SIZE,
  type DueWorkStatement,
} from "./due-work";
import { relinkTracksToEntity } from "./hub-counts";
import { hasIsrc } from "./isrc";
import { setLabelMbLabelId } from "./label-images";
import {
  adoptLabelMbLabelId,
  ensureLabel,
  getEnabledSeedLabel,
  labelFold,
  labelSlug,
  listLabels,
} from "./labels";
import { logEvent } from "./log";
import {
  type MbRequestContext,
  MUSICBRAINZ_API_HOST,
  mbFetch,
  musicbrainzUrl,
} from "./musicbrainz";
import {
  canonicalOperationJson,
  digestOperationRequest,
  executeReceiptBackedOperation,
  type JsonValue,
  type OperationReceiptEffectResult,
  type OperationReceiptOutcome,
} from "./operation-receipts";
import { readEnv } from "./env";
import { ApiError } from "./spotify";
import { insertTrackDuplicateKeyStatement } from "./track-duplicate-keys";

export const DEFAULT_MAX_HOP = 2;

export const MAX_HOP_CEILING = 3;

const BROWSE_PAGE_SIZE = 100;

type CrawlDbClient = Pick<Client, "batch" | "execute">;

const REARM_TAIL = -1;

function descendCursor(offset: number): number {
  return -(offset + 2);
}

function descendOffset(cursor: number): number {
  return -cursor - 2;
}

const MAX_FAILURES = 5;

function throttledSettlement(node: { cursor: number; failures: number }): {
  cursor: number;
  failures: number;
  note: string;
  state: "pending";
} {
  return {
    cursor: node.cursor,
    failures: node.failures,
    note: "musicbrainz rate-limited",
    state: "pending",
  };
}

export const ALLOWED_ARTIST_REARM_AFTER_DAYS = 1;

export const REARM_BATCH = 10;

export const REARM_SCOPED_BATCH = 10;

export const REARM_ALLOWED_BATCH = CRAWL_STALE_ARTIST_REARM_LIMIT;

export const CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND = REARM_ALLOWED_BATCH;

if (CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND >= CRAWL_CLAIM_SOURCE_MARKER_DRAIN_CAPACITY) {
  throw new Error(
    `crawl admission mints up to ${CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND} source repair markers ` +
      `per tick, above the claim's drain capacity of ${CRAWL_CLAIM_SOURCE_MARKER_DRAIN_CAPACITY}`,
  );
}

export const CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND =
  MAX_CRAWL_COMMIT_BATCH * (BROWSE_PAGE_SIZE + 1);

const CRAWL_CLAIM_NODE_MARKER_DRAIN_CAPACITY =
  CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.nodeChunks * CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.nodeChunkRows;

if (CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND >= CRAWL_CLAIM_NODE_MARKER_DRAIN_CAPACITY) {
  throw new Error(
    `a batched crawl commit mints up to ${CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND} node repair ` +
      `markers per phase, above the claim's drain capacity of ${CRAWL_CLAIM_NODE_MARKER_DRAIN_CAPACITY}`,
  );
}

const ARTIST_RULE_MEMO_LIMIT = 10_000;

const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;

const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

export type CrawlNodeKind = "artist" | "label" | "release";
export type CrawlNodeState = "done" | "failed" | "pending" | "skipped";
export type CrawlNodeSource = "fluncle" | "musicbrainz";

type FrontierRow = {
  cursor: number;
  done_at: string | null;
  external_id: string;
  failures: number;
  hop: number;
  id: string;
  kind: CrawlNodeKind;
  label_slug: string | null;
  release_label_slug?: string | null;
  source: CrawlNodeSource;
};

type TrackCandidate = {
  album: string | null;
  albumImageUrl: string | null;
  artists: string[];

  creditMbids: (null | string)[];
  durationMs: number;
  inMasterId: number | null;
  inReleaseId: number | null;
  isrc: string | null;
  label: string | null;
  recordingId: string;
  releaseDate: string | null;
  title: string;
};

export type CrawlPass = {
  artistsRearmed: number;
  dryRun: boolean;

  expanded: number;

  failed: number;

  frontierPending: number;

  labelsDiscovered: string[];
  maxHop: number;

  nodesEnqueued: number;

  rateLimited: boolean;

  releaseDetailsStored: number;

  releasesRearmed: number;

  seeded: number;

  seedsRearmed: number;

  tracksFound: number;

  tracksAllowedIn: number;

  tracksSkippedArtistRule: number;

  tracksSkippedHeld: number;

  tracksSkippedLabelGate: number;

  tracksSkipped: number;

  tracksWritten: number;
};

export type CrawlStatus = {
  anchorsPending: number;

  catalogueTracks: number;

  labelsUndecided: number;

  frontier: { done: number; failed: number; pending: number; skipped: number };
  frontierByKind: { artist: number; label: number; release: number };

  seedLabels: string[];

  storablePending: number;

  undecidedLabelsQueued: number;

  unstorablePending: number;
};

type MbArtistCredit = { artist?: { id?: string; name?: string }; name?: string };
type MbRecording = {
  "artist-credit"?: MbArtistCredit[];
  id?: string;
  isrcs?: string[];
  length?: null | number;
  title?: string;
};
type MbTrack = { length?: null | number; recording?: MbRecording; title?: string };
type MbMedium = { tracks?: MbTrack[] };
type MbRelation = { type?: string; url?: { resource?: string } };
type MbLabelInfo = { label?: { id?: string; name?: string } | null };
type MbReleaseDetail = {
  "artist-credit"?: MbArtistCredit[];
  "cover-art-archive"?: { front?: boolean };
  date?: string;
  id?: string;
  "label-info"?: MbLabelInfo[];
  media?: MbMedium[];
  relations?: MbRelation[];

  "release-group"?: { id?: string };
  title?: string;
};
type MbBrowseRelease = {
  id?: string;

  "label-info"?: { label?: { id?: string; name?: string } | null }[];
  status?: string;
};
type MbReleaseBrowse = {
  "release-count"?: number;
  releases?: MbBrowseRelease[];
};
type MbLabelSearch = { labels?: { id?: string; name?: string; score?: number }[] };

function frontierId(source: CrawlNodeSource, kind: CrawlNodeKind, externalId: string): string {
  return `${source}:${kind}:${externalId}`;
}

export function catalogueTrackId(recordingMbid: string): string {
  return `mb_${recordingMbid}`;
}

const fold = labelFold;

type EnqueueNode = {
  externalId: string;
  hop: number;
  kind: CrawlNodeKind;
  labelSlug: string | null;
  parentId: string | null;
  source: CrawlNodeSource;
};

async function enqueue(node: EnqueueNode, client?: CrawlDbClient): Promise<number> {
  return enqueueMany([node], client);
}

async function enqueueMany(nodes: readonly EnqueueNode[], client?: CrawlDbClient): Promise<number> {
  if (nodes.length === 0) {
    return 0;
  }
  const db = client ?? (await getDb());
  const groups: InStatement[][] = [];
  for (const node of nodes) {
    const now = new Date().toISOString();
    const id = frontierId(node.source, node.kind, node.externalId);
    const sourceVersion = `crawl-enqueue:${crypto.randomUUID()}`;
    groups.push([
      {
        args: [
          id,
          node.kind,
          node.source,
          node.externalId,
          node.hop,
          node.parentId,
          node.labelSlug,
          now,
          now,
        ],
        sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, parent_id, label_slug, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do nothing`,
      },
      markCrawlNodeRepairStatement(id, sourceVersion, {
        now,
        onlyIfPreviousStatementChanged: true,
      }),
    ]);
  }
  const results = await batchDueWorkMutationGroups(db, groups, MAX_CRAWL_DUE_CHUNK_SIZE);
  return results.reduce((count, group) => count + (group[0]?.rowsAffected ?? 0), 0);
}

async function settle(
  id: string,
  state: CrawlNodeState,
  patch: { cursor?: number; failures?: number; note?: string } = {},
  client?: CrawlDbClient,
): Promise<void> {
  const db = client ?? (await getDb());
  const now = new Date().toISOString();

  await db.batch(
    [
      {
        args: [
          state,
          state,
          state === "done" ? now : null,
          state,
          patch.cursor ?? 0,
          patch.failures ?? 0,
          patch.note ?? null,
          now,
          now,
          id,
        ],
        sql: `update crawl_frontier
              set state = ?,
                  done_at = case
                    when ? = 'done' then ?
                    when ? in ('pending', 'failed') and done_at is not null then done_at
                    else null
                  end,
                  cursor = ?, failures = ?, note = ?,
                  attempts = attempts + 1, attempted_at = ?, updated_at = ?
              where id = ?`,
      },
      markCrawlNodeRepairStatement(id, `crawl-settle:${crypto.randomUUID()}`, {
        now,
        onlyIfPreviousStatementChanged: true,
      }),
    ],
    "write",
  );
}

async function pickNodes(limit: number): Promise<FrontierRow[]> {
  const db = await getDb();
  const now = Date.now();

  const cutoff = (failures: number): string =>
    new Date(now - Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS)).toISOString();

  const eligible = `(state = 'pending'
             or (state = 'failed'
                 and failures < ?
                 and attempted_at <= (case failures
                                        when 1 then ?
                                        when 2 then ?
                                        when 3 then ?
                                        else ? end)))`;
  const releaseShare = Math.ceil(limit / 2);
  const cutoffs = [MAX_FAILURES, cutoff(1), cutoff(2), cutoff(3), cutoff(4)];

  const releases = await db.execute({
    args: [...cutoffs, releaseShare],
    sql: `select crawl_frontier.id, kind, source, external_id, hop, cursor, failures, label_slug,
                release_label_slug,
                crawl_frontier.done_at,
                case
                  when provenance_label.seed_state = 'enabled' then 1
                  when crawl_frontier.parent_id in (
                    select 'musicbrainz:artist:' || artist_mbid
                    from artist_rules where verdict = 'allow'
                  ) then 1
                  else 0
                end as is_storable
          from crawl_frontier
          left join labels as provenance_label
            on provenance_label.slug = ${crawlRankLabelSlugSql("crawl_frontier.")}
          where kind = 'release' and ${eligible}
          order by is_storable desc, crawl_frontier.hop asc, demand_rank asc,
                   crawl_frontier.created_at asc, crawl_frontier.id asc
          limit ?`,
  });
  const releaseRows = typedRows<FrontierRow>(releases.rows);
  const remainder = limit - releaseRows.length;

  if (remainder <= 0) {
    return releaseRows;
  }

  const placeholders = releaseRows.map(() => "?").join(", ");
  const rest = await db.execute({
    args: [...cutoffs, ...releaseRows.map((row) => row.id), remainder],
    sql: `select id, kind, source, external_id, hop, cursor, failures, label_slug,
                 release_label_slug, done_at
          from crawl_frontier
          where ${eligible}
            ${releaseRows.length > 0 ? `and id not in (${placeholders})` : ""}
          order by hop asc, demand_rank asc, created_at asc, id asc
          limit ?`,
  });

  return [...releaseRows, ...typedRows<FrontierRow>(rest.rows)];
}

async function canonicalLabelRow(
  name: string,
  client?: Pick<Client, "execute">,
): Promise<undefined | { id: string; mbLabelId: null | string; name: string }> {
  const db = client ?? (await getDb());
  const result = await db.execute("select id, name, mb_label_id from labels");
  const want = fold(name);
  const row = typedRows<{ id: string; mb_label_id: null | string; name: string }>(result.rows).find(
    (candidate) => fold(candidate.name) === want,
  );

  return row ? { id: row.id, mbLabelId: row.mb_label_id, name: row.name } : undefined;
}

const SEED_PROBE_CHUNK_SIZE = 500;

async function seedFromEnabledLabels(): Promise<{ minted: number; slugs: string[] }> {
  const enabled = await listLabels("enabled");
  const slugs = enabled.map((label) => label.slug);
  if (slugs.length === 0) {
    return { minted: 0, slugs };
  }

  const db = await getDb();
  const held = new Set<string>();
  for (let offset = 0; offset < slugs.length; offset += SEED_PROBE_CHUNK_SIZE) {
    const chunk = slugs
      .slice(offset, offset + SEED_PROBE_CHUNK_SIZE)
      .map((slug) => frontierId("fluncle", "label", slug));
    const existing = await db.execute({
      args: chunk,
      sql: `select id from crawl_frontier where id in (${chunk.map(() => "?").join(", ")})`,
    });
    for (const row of typedRows<{ id: string }>(existing.rows)) {
      held.add(row.id);
    }
  }

  const missing = enabled.filter((label) => !held.has(frontierId("fluncle", "label", label.slug)));
  const minted = await enqueueMany(
    missing.map((label) => ({
      externalId: label.slug,
      hop: 0,
      kind: "label" as const,
      labelSlug: label.slug,
      parentId: null,
      source: "fluncle" as const,
    })),
    db,
  );

  return { minted, slugs };
}

async function rearmSeedLabels(): Promise<number> {
  const db = await getDb();
  const cutoff = currentSeedRearmBoundary().toISOString();
  const now = new Date().toISOString();
  const selected = await db.execute({
    args: [cutoff, REARM_BATCH],
    sql: `select node.id from crawl_frontier as node
          where node.kind = 'label' and node.source = 'musicbrainz'
            and node.state = 'done' and node.done_at is not null and node.done_at < ?
            and exists (
              select 1 from labels
              where labels.slug = node.label_slug and labels.seed_state = 'enabled'
                and (labels.mb_label_id is null or labels.mb_label_id = node.external_id)
            )
          order by node.done_at asc, node.id asc limit ?`,
  });
  const nodeIds = typedRows<{ id: string }>(selected.rows).map((row) => row.id);
  if (nodeIds.length === 0) {
    return 0;
  }
  const placeholders = nodeIds.map(() => "?").join(", ");
  const results = await db.batch(
    [
      {
        args: [REARM_TAIL, now, ...nodeIds, cutoff],
        sql: `update crawl_frontier
              set state = 'pending', cursor = ?, updated_at = ?
              where id in (${placeholders}) and kind = 'label' and source = 'musicbrainz'
                and state = 'done' and done_at is not null and done_at < ?
                and exists (
                  select 1 from labels where labels.slug = crawl_frontier.label_slug
                    and labels.seed_state = 'enabled'
                    and (labels.mb_label_id is null
                      or labels.mb_label_id = crawl_frontier.external_id)
                )`,
      },
      markCrawlNodeRepairsByUpdatedAtStatement(
        nodeIds,
        `crawl-seed-rearm:${crypto.randomUUID()}`,
        now,
      ),
    ],
    "write",
  );

  const rearmed = results[0]?.rowsAffected ?? 0;

  if (rearmed > 0) {
    logEvent("info", "crawl.seeds-rearmed", { count: rearmed });
  }

  return rearmed;
}

async function rearmScopedLabelReleases(): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const selected = await db.execute({
    args: [REARM_SCOPED_BATCH],
    sql: `select node.id from crawl_frontier as node
          where node.kind = 'label' and node.source = 'musicbrainz'
            and node.state = 'done' and node.done_at is not null
            and exists (
              select 1 from labels
              where labels.slug = node.label_slug and labels.seed_state = 'enabled'
                and labels.scope_changed_at is not null
                and labels.scope_changed_at > node.done_at
                and (labels.mb_label_id is null or labels.mb_label_id = node.external_id)
            )
          order by node.done_at asc, node.id asc limit ?`,
  });
  const nodeIds = typedRows<{ id: string }>(selected.rows).map((row) => row.id);
  if (nodeIds.length === 0) {
    return 0;
  }
  const placeholders = nodeIds.map(() => "?").join(", ");
  const results = await db.batch(
    [
      {
        args: [now, ...nodeIds],
        sql: `update crawl_frontier
              set state = 'pending', cursor = 0, updated_at = ?
              where id in (${placeholders}) and kind = 'label' and source = 'musicbrainz'
                and state = 'done' and done_at is not null
                and exists (
                  select 1 from labels where labels.slug = crawl_frontier.label_slug
                    and labels.seed_state = 'enabled' and labels.scope_changed_at is not null
                    and labels.scope_changed_at > crawl_frontier.done_at
                    and (labels.mb_label_id is null
                      or labels.mb_label_id = crawl_frontier.external_id)
                )`,
      },
      markCrawlNodeRepairsByUpdatedAtStatement(
        nodeIds,
        `crawl-scope-rearm:${crypto.randomUUID()}`,
        now,
      ),
    ],
    "write",
  );

  const rearmed = results[0]?.rowsAffected ?? 0;

  if (rearmed > 0) {
    logEvent("info", "crawl.releases-rearmed", { count: rearmed });
  }

  return rearmed;
}

async function rearmSkippedDisabledReleases(maxHop: number): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const globalAllow = await db.execute({
    args: [],
    sql: `select 1 from artist_rules where verdict = 'allow' and label_id is null limit 1`,
  });
  const rearmAll = maxHop > 2 || globalAllow.rows.length > 0;
  const selected = await db.execute({
    args: [REARM_SCOPED_BATCH],
    sql: `select node.id from crawl_frontier as node indexed by crawl_frontier_disabled_skip_idx
          where node.state = 'skipped' and node.kind = 'release'
            and node.note = 'disabled own label at terminal hop'
            ${
              rearmAll
                ? ""
                : `and node.release_label_slug in (
                    select label.slug from labels as label
                    where label.seed_state = 'enabled'
                      or exists (select 1 from artist_rules as rule
                        where rule.label_id = label.id and rule.verdict = 'allow')
                    union
                    select alias.alias_slug from label_aliases as alias
                    join labels as label on label.id = alias.label_id
                    where alias.status = 'confirmed'
                      and (label.seed_state = 'enabled'
                        or exists (select 1 from artist_rules as rule
                          where rule.label_id = label.id and rule.verdict = 'allow'))
                  )`
            }
          order by node.release_label_slug, node.id limit ?`,
  });
  const ids = typedRows<{ id: string }>(selected.rows).map((row) => row.id);
  if (ids.length === 0) {
    return 0;
  }
  const result = await db.batch(
    [
      {
        args: [now, ...ids],
        sql: `update crawl_frontier set state = 'pending', cursor = 0, note = null,
                updated_at = ? where id in (${ids.map(() => "?").join(", ")})
                and state = 'skipped' and note = 'disabled own label at terminal hop'`,
      },
      markCrawlNodeRepairsByUpdatedAtStatement(
        ids,
        `crawl-disabled-rearm:${crypto.randomUUID()}`,
        now,
      ),
    ],
    "write",
  );
  return result[0]?.rowsAffected ?? 0;
}

async function rearmAllowedArtists(): Promise<number> {
  const db = await getDb();
  const selected = await db.execute({
    args: [REARM_ALLOWED_BATCH],
    sql: `select artist_mbid
          from artist_rules
          where verdict = 'allow' and rearmed_at is null
          group by artist_mbid
          order by min(created_at) asc, artist_mbid asc
          limit ?`,
  });
  const artistMbids = typedRows<{ artist_mbid: string }>(selected.rows).map(
    (row) => row.artist_mbid,
  );

  if (artistMbids.length === 0) {
    return 0;
  }

  const now = new Date().toISOString();
  const sourceVersion = `crawl-artist-rearm:${crypto.randomUUID()}`;

  const writes: DueWorkStatement[] = [];
  for (const artistMbid of artistMbids) {
    const nodeId = frontierId("musicbrainz", "artist", artistMbid);
    writes.push(
      {
        args: [nodeId, artistMbid, now, now],
        sql: `insert into crawl_frontier
                (id, kind, source, external_id, hop, parent_id, label_slug, state, cursor,
                 created_at, updated_at)
              values (?, 'artist', 'musicbrainz', ?, 0, null, null, 'pending', 0, ?, ?)
              on conflict (id) do update set
                state = case
                  when crawl_frontier.state = 'failed' then 'failed' else 'pending' end,
                cursor = 0, hop = 0, parent_id = null,
                label_slug = null, updated_at = excluded.updated_at
              where crawl_frontier.state in ('done', 'failed', 'pending')`,
      },
      markCrawlNodeRepairStatement(nodeId, sourceVersion, {
        now,
        onlyIfPreviousStatementChanged: true,
      }),
    );
  }
  writes.push(
    {
      args: [now, ...artistMbids],
      sql: `update artist_rules set rearmed_at = ?
              where verdict = 'allow' and rearmed_at is null
                and artist_mbid in (${artistMbids.map(() => "?").join(", ")})`,
    },
    ...artistMbids.map((artistMbid) =>
      markCrawlProjectionRepairStatement("artist", artistMbid, {
        now,
        onlyIfPreviousStatementChanged: true,
        sourceVersion,
      }),
    ),
  );
  await db.batch(writes, "write");

  logEvent("info", "crawl.artists-rearmed", { count: artistMbids.length, mode: "forward" });
  return artistMbids.length;
}

async function rearmStaleAllowedArtists(): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(
    Date.now() - ALLOWED_ARTIST_REARM_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const now = new Date().toISOString();
  const selected = await db.execute({
    args: [cutoff, REARM_ALLOWED_BATCH],
    sql: `select node.id from crawl_frontier as node
          where node.kind = 'artist' and node.source = 'musicbrainz'
            and node.state = 'done' and node.done_at is not null and node.done_at < ?
            and exists (
              select 1 from artist_rules
              where artist_rules.artist_mbid = node.external_id
                and artist_rules.verdict = 'allow'
            )
            and not exists (
              select 1 from artist_rules as outstanding
              where outstanding.artist_mbid = node.external_id
                and outstanding.verdict = 'allow' and outstanding.rearmed_at is null
            )
          order by node.done_at asc, node.id asc limit ?`,
  });
  const nodeIds = typedRows<{ id: string }>(selected.rows).map((row) => row.id);
  if (nodeIds.length === 0) {
    return 0;
  }
  const placeholders = nodeIds.map(() => "?").join(", ");
  const results = await db.batch(
    [
      {
        args: [REARM_TAIL, now, ...nodeIds, cutoff],
        sql: `update crawl_frontier
              set state = 'pending', cursor = ?, updated_at = ?
              where id in (${placeholders}) and kind = 'artist' and source = 'musicbrainz'
                and state = 'done' and done_at is not null and done_at < ?
                and exists (
                  select 1 from artist_rules
                  where artist_rules.artist_mbid = crawl_frontier.external_id
                    and artist_rules.verdict = 'allow'
                )
                and not exists (
                  select 1 from artist_rules as outstanding
                  where outstanding.artist_mbid = crawl_frontier.external_id
                    and outstanding.verdict = 'allow' and outstanding.rearmed_at is null
                )`,
      },
      markCrawlNodeRepairsByUpdatedAtStatement(
        nodeIds,
        `crawl-artist-tail-rearm:${crypto.randomUUID()}`,
        now,
      ),
    ],
    "write",
  );
  const rearmed = results[0]?.rowsAffected ?? 0;

  if (rearmed > 0) {
    logEvent("info", "crawl.artists-rearmed", { count: rearmed, mode: "tail" });
  }

  return rearmed;
}

async function writeCatalogueTracks(
  candidates: TrackCandidate[],
  releaseAlbumId: null | string,
  client?: CrawlDbClient,
): Promise<{ skipped: number; written: number; writtenIds: string[] }> {
  if (candidates.length === 0) {
    return { skipped: 0, written: 0, writtenIds: [] };
  }

  const db = client ?? (await getDb());
  const ids = candidates.map((candidate) => catalogueTrackId(candidate.recordingId));
  const isrcs = candidates
    .map((candidate) => candidate.isrc)
    .filter((isrc): isrc is string => Boolean(isrc));

  const existing = await db.execute({
    args: [...ids, ...isrcs],
    sql: `select track_id, isrc from tracks
          where track_id in (${ids.map(() => "?").join(", ")})
          ${isrcs.length > 0 ? `or isrc in (${isrcs.map(() => "?").join(", ")})` : ""}`,
  });

  const heldIds = new Set<string>();
  const heldIsrcs = new Set<string>();

  for (const row of typedRows<{ isrc: null | string; track_id: string }>(existing.rows)) {
    heldIds.add(row.track_id);

    if (row.isrc) {
      heldIsrcs.add(row.isrc);
    }
  }

  const albumTitleFolds = await existingAlbumTitleFolds(releaseAlbumId, db);

  let written = 0;
  let skipped = 0;
  const writtenIds: string[] = [];
  const plannedGroups: InStatement[][] = [];
  const plannedTrackIds: string[] = [];

  const writtenAt = new Date().toISOString();

  for (const candidate of candidates) {
    const trackId = catalogueTrackId(candidate.recordingId);
    const titleFold = foldTrackTitle(candidate.title);

    if (
      heldIds.has(trackId) ||
      (candidate.isrc && heldIsrcs.has(candidate.isrc)) ||
      (releaseAlbumId && titleFold && albumTitleFolds.has(titleFold))
    ) {
      skipped += 1;
      continue;
    }

    const artistsJson = JSON.stringify(candidate.artists);
    const insertTrack = {
      args: [
        trackId,
        candidate.title,
        artistsJson,
        candidate.durationMs,
        candidate.album,
        candidate.albumImageUrl,
        candidate.isrc,

        hasIsrc(candidate.isrc),
        candidate.label,
        candidate.releaseDate,
        candidate.inReleaseId,
        candidate.inMasterId,

        candidate.recordingId,

        writtenAt,
        writtenAt,
        candidate.inReleaseId === null && candidate.inMasterId === null ? null : writtenAt,
      ],
      sql: `insert into tracks
              (track_id, title, artists_json, duration_ms, album, album_image_url, isrc,
               has_isrc, label, release_date, in_release_id, in_master_id, mb_recording_id,
               isrc_attempted_at, backfill_discogs_attempted_at, backfill_discogs_done_at,
               backfill_discogs_attempts)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            on conflict (track_id) do nothing`,
    };
    const duplicateKeyStatement = insertTrackDuplicateKeyStatement({
      artistsJson,
      isrc: candidate.isrc,
      title: candidate.title,
      trackId,
    });

    if (!client) {
      const result = (
        await batchDueWorkSourceMutation(
          db,
          [insertTrack, duplicateKeyStatement],
          [{ subjectId: trackId, subjectType: "track" }],
          { onlyIfLastSourceStatementChanged: true, producer: "crawl-track-mint" },
        )
      )[0];
      if (!result) {
        throw new Error("Catalogue track insert batch returned no track result");
      }
      if (result.rowsAffected > 0) {
        written += 1;
        writtenIds.push(trackId);
        heldIds.add(trackId);
        if (candidate.isrc) {
          heldIsrcs.add(candidate.isrc);
        }
        if (titleFold) {
          albumTitleFolds.set(titleFold, trackId);
        }
      } else {
        skipped += 1;
      }
      continue;
    }

    plannedGroups.push(
      dueWorkSourceMutationStatements(
        [insertTrack, duplicateKeyStatement],
        [{ subjectId: trackId, subjectType: "track" }],
        { onlyIfLastSourceStatementChanged: true, producer: "crawl-track-mint" },
      ),
    );
    plannedTrackIds.push(trackId);
    heldIds.add(trackId);

    if (candidate.isrc) {
      heldIsrcs.add(candidate.isrc);
    }

    if (titleFold) {
      albumTitleFolds.set(titleFold, trackId);
    }
  }

  const groupedResults = await batchDueWorkMutationGroups(
    db,
    plannedGroups,
    MAX_DUE_WORK_CHUNK_SIZE,
  );

  for (const [index, results] of groupedResults.entries()) {
    const result = results[0];

    if (!result) {
      throw new Error("Catalogue track insert batch returned no track result");
    }

    if (result.rowsAffected > 0) {
      written += 1;
      const trackId = plannedTrackIds[index];
      if (!trackId) {
        throw new Error("Catalogue track mutation result has no planned candidate");
      }
      writtenIds.push(trackId);
    } else {
      skipped += 1;
    }
  }

  return { skipped, written, writtenIds };
}

async function linkTracksToLabel(
  trackIds: string[],
  labelName: string,
  mbLabelId: null | string,
  client?: CrawlDbClient,
): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  const db = client ?? (await getDb());
  const mbid = mbLabelId?.trim() ? mbLabelId.trim() : null;

  let labelId: string | undefined;

  if (mbid) {
    const byMbid = await db.execute({
      args: [mbid],
      sql: `select id from labels where mb_label_id = ? limit 1`,
    });
    labelId = typedRows<{ id: string }>(byMbid.rows)[0]?.id;
  }

  if (!labelId) {
    const slug = labelSlug(labelName);

    if (!slug) {
      return;
    }

    const found = await db.execute({
      args: [slug],
      sql: `select id from labels where slug = ? limit 1`,
    });
    labelId = typedRows<{ id: string }>(found.rows)[0]?.id;
  }

  if (!labelId) {
    return;
  }

  await relinkTracksToEntity("labels", labelId, trackIds, db);
}

async function linkTracksToAlbumId(
  trackIds: string[],
  albumId: null | string,
  client?: CrawlDbClient,
): Promise<void> {
  if (trackIds.length === 0 || !albumId) {
    return;
  }

  await relinkTracksToEntity("albums", albumId, trackIds, client);
}

type Expansion = {
  enqueued: number;
  labelsDiscovered: string[];
  next: { cursor: number; state: CrawlNodeState; note?: string };
  tracksAllowedIn: number;
  tracksFound: number;
  tracksSkippedArtistRule: number;
  tracksSkippedHeld: number;
  tracksSkippedLabelGate: number;
  tracksSkipped: number;
  tracksWritten: number;
};

const EMPTY: Expansion = {
  enqueued: 0,
  labelsDiscovered: [],
  next: { cursor: 0, state: "done" },
  tracksAllowedIn: 0,
  tracksFound: 0,
  tracksSkipped: 0,
  tracksSkippedArtistRule: 0,
  tracksSkippedHeld: 0,
  tracksSkippedLabelGate: 0,
  tracksWritten: 0,
};

type CrawlProviderPlan =
  | { kind: "browse-forward"; childHop: number; key: "artist" | "label" }
  | { kind: "browse-rearmed"; childHop: number; key: "artist" | "label" }
  | { kind: "release" }
  | { kind: "skip-disabled" }
  | {
      kind: "seed";
      label: null | { mbLabelId: string | null; name: string; slug: string };
    }
  | { kind: "terminal"; expansion: Expansion };

type RearmedBrowseProviderData = {
  offset: number;
  page: MbReleaseBrowse | null;
  staleTotal: number | null;
};

type CrawlProviderData =
  | { kind: "browse-forward"; browse: MbReleaseBrowse | null }
  | { kind: "browse-rearmed"; browse: RearmedBrowseProviderData }
  | { kind: "release"; release: MbReleaseDetail | null }
  | { kind: "seed"; search: MbLabelSearch | null }
  | { kind: "terminal" };

type CrawlProviderOutcome =
  | { kind: "failed"; message: string; rateLimited: boolean }
  | { data: CrawlProviderData; kind: "success" };

class ThrottledError extends Error {}

export type CrawlProviderTransport = <T>(
  path: string,
  context?: MbRequestContext,
) => Promise<T | null>;

async function mb<T>(path: string, context?: MbRequestContext): Promise<T | null> {
  const { data, rateLimited } = await mbFetch<T>(path, context);

  if (rateLimited) {
    throw new ThrottledError(`MusicBrainz is rate-limiting (${path})`);
  }

  return data;
}

function releasePath(externalId: string): string {
  return `/release/${externalId}?inc=recordings+artist-credits+isrcs+labels+release-groups+url-rels`;
}

function seedSearchPath(name: string): string {
  return `/label?query=${encodeURIComponent(name)}&limit=5`;
}

function browsePath(
  key: string,
  externalId: string,
  limit: number,
  offset: number | string,
): string {
  const inc = key === "artist" ? "&inc=labels" : "";
  return `/release?${key}=${externalId}&limit=${limit}&offset=${offset}${inc}`;
}

async function planCrawlNode(
  node: FrontierRow,
  maxHop: number,
  client?: Pick<Client, "execute">,
): Promise<CrawlProviderPlan> {
  if (node.kind === "release") {
    if (node.hop === 2 && maxHop <= 2 && (await disabledTerminalRelease(node, client))) {
      return { kind: "skip-disabled" };
    }
    return { kind: "release" };
  }
  if (node.kind === "label" && node.source === "fluncle") {
    const label = await getEnabledSeedLabel(node.external_id, client);
    return {
      kind: "seed",
      label: label
        ? {
            mbLabelId: label.mbLabelId ?? null,
            name: label.name,
            slug: label.slug,
          }
        : null,
    };
  }

  const childHop = node.kind === "label" ? 0 : node.hop + 1;
  if (childHop > maxHop) {
    return {
      expansion: { ...EMPTY, next: { cursor: 0, note: `hop limit ${maxHop}`, state: "done" } },
      kind: "terminal",
    };
  }
  const key = node.kind === "label" ? "label" : "artist";
  return node.cursor < 0
    ? { childHop, key, kind: "browse-rearmed" }
    : { childHop, key, kind: "browse-forward" };
}

async function disabledTerminalRelease(
  node: FrontierRow,
  client?: Pick<Client, "execute">,
): Promise<boolean> {
  if (!node.release_label_slug) {
    return false;
  }
  const db = client ?? (await getDb());
  const result = await db.execute({
    args: [node.release_label_slug],
    sql: `select 1 from labels as label
          where label.slug = ? and label.seed_state = 'disabled'
            and not exists (select 1 from artist_rules as rule
              where rule.verdict = 'allow'
                and (rule.label_id = label.id or rule.label_id is null))
          limit 1`,
  });
  return result.rows.length > 0;
}

async function fetchCrawlProvider(
  plan: CrawlProviderPlan,
  node: FrontierRow,
  read: CrawlProviderTransport = mb,
): Promise<CrawlProviderData> {
  const request = <T>(path: string, requestKind: MbRequestContext["requestKind"]) =>
    read<T>(path, { nodeKind: node.kind, requestKind });
  if (plan.kind === "terminal" || plan.kind === "skip-disabled") {
    return { kind: "terminal" };
  }
  if (plan.kind === "release") {
    return {
      kind: "release",
      release: await request<MbReleaseDetail>(releasePath(node.external_id), "release_detail"),
    };
  }
  if (plan.kind === "seed") {
    if (!plan.label || plan.label.mbLabelId) {
      return { kind: "seed", search: null };
    }
    return {
      kind: "seed",
      search: await request<MbLabelSearch>(seedSearchPath(plan.label.name), "seed_search"),
    };
  }
  if (plan.kind === "browse-forward") {
    return {
      browse: await request<MbReleaseBrowse>(
        browsePath(plan.key, node.external_id, BROWSE_PAGE_SIZE, node.cursor),
        plan.key === "artist" ? "artist_browse" : "label_browse",
      ),
      kind: "browse-forward",
    };
  }

  const browse = (
    offset: number,
    limit: number,
    requestKind: MbRequestContext["requestKind"],
  ): Promise<MbReleaseBrowse | null> =>
    request<MbReleaseBrowse>(browsePath(plan.key, node.external_id, limit, offset), requestKind);
  let offset: number;
  let staleTotal: null | number = null;
  if (node.cursor === REARM_TAIL) {
    const probe = await browse(0, 1, "rearm_probe");
    staleTotal = probe?.["release-count"] ?? 0;
    if (staleTotal <= 0) {
      return {
        browse: { offset: 0, page: null, staleTotal },
        kind: "browse-rearmed",
      };
    }
    offset = Math.max(0, staleTotal - BROWSE_PAGE_SIZE);
  } else {
    offset = descendOffset(node.cursor);
  }
  return {
    browse: {
      offset,
      page: await browse(
        offset,
        BROWSE_PAGE_SIZE,
        plan.key === "artist" ? "artist_browse" : "label_browse",
      ),
      staleTotal,
    },
    kind: "browse-rearmed",
  };
}

export type CrawlFetchPlan =
  | { kind: "none" }
  | { kind: "single"; url: string }
  | {
      countField: "release-count";
      kind: "tail";
      pageSize: number;
      pageUrlTemplate: string;
      probeUrl: string;
    };

export const CRAWL_FETCH_OFFSET_SLOT = "{offset}";

export function crawlFetchPlan(plan: CrawlProviderPlan, node: FrontierRow): CrawlFetchPlan {
  if (plan.kind === "terminal" || plan.kind === "skip-disabled") {
    return { kind: "none" };
  }
  if (plan.kind === "release") {
    return { kind: "single", url: musicbrainzUrl(releasePath(node.external_id)) };
  }
  if (plan.kind === "seed") {
    return !plan.label || plan.label.mbLabelId
      ? { kind: "none" }
      : { kind: "single", url: musicbrainzUrl(seedSearchPath(plan.label.name)) };
  }
  if (plan.kind === "browse-forward") {
    return {
      kind: "single",
      url: musicbrainzUrl(browsePath(plan.key, node.external_id, BROWSE_PAGE_SIZE, node.cursor)),
    };
  }
  if (node.cursor === REARM_TAIL) {
    return {
      countField: "release-count",
      kind: "tail",
      pageSize: BROWSE_PAGE_SIZE,
      pageUrlTemplate: musicbrainzUrl(
        browsePath(plan.key, node.external_id, BROWSE_PAGE_SIZE, CRAWL_FETCH_OFFSET_SLOT),
      ),
      probeUrl: musicbrainzUrl(browsePath(plan.key, node.external_id, 1, 0)),
    };
  }
  return {
    kind: "single",
    url: musicbrainzUrl(
      browsePath(plan.key, node.external_id, BROWSE_PAGE_SIZE, descendOffset(node.cursor)),
    ),
  };
}

export type SuppliedCrawlBody = {
  body?: unknown;
  outcome: "body" | "empty" | "invalid" | "oversize" | "throttled";
  url: string;
};

function assertMusicbrainzUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("crawl fetch body carries a url that is not a url");
  }
  if (parsed.protocol !== "https:" || parsed.host !== MUSICBRAINZ_API_HOST) {
    throw new Error("crawl fetch body carries a url outside MusicBrainz");
  }
}

function matchesOffsetTemplate(template: string, url: string): boolean {
  const slot = template.indexOf(CRAWL_FETCH_OFFSET_SLOT);
  if (slot < 0) {
    return false;
  }
  const head = template.slice(0, slot);
  const tail = template.slice(slot + CRAWL_FETCH_OFFSET_SLOT.length);
  if (!url.startsWith(head) || !url.endsWith(tail) || url.length <= head.length + tail.length) {
    return false;
  }
  const offset = url.slice(head.length, url.length - tail.length);
  return /^(0|[1-9][0-9]{0,15})$/.test(offset) && Number.isSafeInteger(Number(offset));
}

export function suppliedCrawlBodies(
  plan: CrawlProviderPlan,
  node: FrontierRow,
  supplied: readonly SuppliedCrawlBody[],
): Map<string, SuppliedCrawlBody> {
  const fetchPlan = crawlFetchPlan(plan, node);
  const accepted = new Map<string, SuppliedCrawlBody>();
  for (const entry of supplied) {
    assertMusicbrainzUrl(entry.url);
    const issued =
      fetchPlan.kind === "single"
        ? entry.url === fetchPlan.url
        : fetchPlan.kind === "tail" &&
          (entry.url === fetchPlan.probeUrl ||
            matchesOffsetTemplate(fetchPlan.pageUrlTemplate, entry.url));
    if (!issued) {
      throw new Error("crawl fetch body is not for a url this claim issued");
    }
    if (accepted.has(entry.url)) {
      throw new Error("crawl fetch bodies repeat a url");
    }
    accepted.set(entry.url, boundedSuppliedBody(entry));
  }
  return accepted;
}

function boundedSuppliedBody(entry: SuppliedCrawlBody): SuppliedCrawlBody {
  if (entry.outcome !== "body") {
    return { outcome: entry.outcome, url: entry.url };
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(entry.body ?? null), "utf8");
  } catch {
    return { outcome: "invalid", url: entry.url };
  }
  return bytes > CRAWL_PHASE_TOKEN_MAX_BYTES
    ? { outcome: "oversize", url: entry.url }
    : { body: entry.body ?? null, outcome: "body", url: entry.url };
}

function suppliedCrawlProviderTransport(
  supplied: Map<string, SuppliedCrawlBody>,
  live: CrawlProviderTransport,
): CrawlProviderTransport {
  return async <T>(path: string, context?: MbRequestContext): Promise<T | null> => {
    const entry = supplied.get(musicbrainzUrl(path));
    if (entry === undefined) {
      return live<T>(path, context);
    }
    if (entry.outcome === "throttled") {
      throw new ThrottledError(`MusicBrainz is rate-limiting (${path})`);
    }
    if (entry.outcome === "oversize") {
      throw new Error("MusicBrainz response exceeded the bounded crawl provider envelope");
    }
    if (entry.outcome === "invalid") {
      throw new Error(`MusicBrainz returned a body that is not JSON (${path})`);
    }
    return entry.outcome === "empty" ? null : (entry.body as T);
  };
}

async function applySeedLabel(
  node: FrontierRow,
  plan: Extract<CrawlProviderPlan, { kind: "seed" }>,
  search: MbLabelSearch | null,
  client?: CrawlDbClient,
): Promise<Expansion> {
  const label = await getEnabledSeedLabel(node.external_id, client);

  if (!label) {
    return { ...EMPTY, next: { cursor: 0, note: "label no longer enabled", state: "skipped" } };
  }

  if (label.mbLabelId) {
    return {
      ...EMPTY,
      enqueued: await enqueue(
        {
          externalId: label.mbLabelId,
          hop: 0,
          kind: "label",
          labelSlug: label.slug,
          parentId: node.id,
          source: "musicbrainz",
        },
        client,
      ),
    };
  }

  if (!plan.label || plan.label.name !== label.name || plan.label.slug !== label.slug) {
    return {
      ...EMPTY,
      next: {
        cursor: node.cursor,
        note: "label changed while provider was pending",
        state: "pending",
      },
    };
  }

  const want = fold(label.name);
  const matches = (search?.labels ?? []).filter(
    (candidate): candidate is { id: string; name: string } =>
      typeof candidate.id === "string" &&
      typeof candidate.name === "string" &&
      fold(candidate.name) === want,
  );

  const candidateIds = [...new Set(matches.map((candidate) => candidate.id))];
  const [only] = candidateIds;

  if (!only) {
    return {
      ...EMPTY,
      next: { cursor: 0, note: "no exact MusicBrainz label match", state: "skipped" },
    };
  }

  if (candidateIds.length > 1) {
    logEvent("warn", "crawl.seed-label-ambiguous", { candidates: candidateIds, slug: label.slug });

    return {
      ...EMPTY,
      next: {
        cursor: 0,
        note: `ambiguous MusicBrainz label match: ${candidateIds.join(", ")}`,
        state: "skipped",
      },
    };
  }

  await setLabelMbLabelId(label.slug, only, client).catch((error) => {
    logEvent("warn", "crawl.persist-mb-label-id-failed", { error, slug: label.slug });
  });

  const enqueued = await enqueue(
    {
      externalId: only,
      hop: 0,
      kind: "label",
      labelSlug: label.slug,
      parentId: node.id,
      source: "musicbrainz",
    },
    client,
  );

  return { ...EMPTY, enqueued };
}

type BrowsedRelease = { id: string; label: null | { id: null | string; name: null | string } };

function browseReleases(browse: MbReleaseBrowse | null, scoped = false): BrowsedRelease[] {
  return (browse?.releases ?? [])
    .filter(
      (release): release is MbBrowseRelease & { id: string } =>
        typeof release.id === "string" &&
        (!scoped || (release.status !== "Bootleg" && release.status !== "Pseudo-Release")),
    )
    .map((release) => {
      const label = (release["label-info"] ?? []).find((info) => info.label?.name)?.label;
      return {
        id: release.id,
        label: label ? { id: label.id ?? null, name: label.name ?? null } : null,
      };
    });
}

const AMBIGUOUS_FOLD = Symbol("ambiguous label fold");

async function releaseLabelSlugs(
  node: FrontierRow,
  releases: readonly BrowsedRelease[],
  client?: CrawlDbClient,
): Promise<Map<string, null | string>> {
  if (node.kind === "label") {
    return new Map(releases.map((release) => [release.id, node.label_slug]));
  }
  if (!releases.some((release) => release.label !== null)) {
    return new Map(releases.map((release) => [release.id, null]));
  }
  const db = client ?? (await getDb());
  const result = await db.execute("select slug, name, mb_label_id from labels");
  const byMbid = new Map<string, string>();
  const byFold = new Map<string, string | typeof AMBIGUOUS_FOLD>();
  for (const row of typedRows<{ mb_label_id: null | string; name: string; slug: string }>(
    result.rows,
  )) {
    if (row.mb_label_id) {
      byMbid.set(row.mb_label_id, row.slug);
    }
    const key = fold(row.name);
    if (key) {
      const previous = byFold.get(key);
      byFold.set(key, previous === undefined || previous === row.slug ? row.slug : AMBIGUOUS_FOLD);
    }
  }
  const slugFor = (label: BrowsedRelease["label"]): null | string => {
    if (!label) {
      return null;
    }
    const exact = label.id ? byMbid.get(label.id) : undefined;
    if (exact) {
      return exact;
    }
    const folded = label.name ? byFold.get(fold(label.name)) : undefined;
    return typeof folded === "string" ? folded : null;
  };
  return new Map(releases.map((release) => [release.id, slugFor(release.label)]));
}

async function enqueueReleaseNodes(
  node: FrontierRow,
  releases: BrowsedRelease[],
  childHop: number,
  replayWatermark?: string,
  client?: CrawlDbClient,
): Promise<number> {
  if (releases.length === 0) {
    return 0;
  }
  const db = client ?? (await getDb());
  const ownLabels = await releaseLabelSlugs(node, releases, client);
  const groups: InStatement[][] = [];

  const insertGroups = new Set<number>();
  for (const release of releases) {
    const now = new Date().toISOString();
    const nodeId = frontierId("musicbrainz", "release", release.id);
    const releaseLabelSlug = ownLabels.get(release.id) ?? null;
    const args = {
      createdAt: now,
      externalId: release.id,
      hop: childHop,
      id: nodeId,
      kind: "release",
      labelSlug: node.label_slug,
      parentId: node.id,
      releaseLabelSlug,
      source: "musicbrainz",
      updatedAt: now,
    };
    insertGroups.add(groups.length);
    if (replayWatermark) {
      groups.push([
        {
          args: { ...args, watermark: replayWatermark },
          sql: `insert into crawl_frontier
                  (id, kind, source, external_id, hop, parent_id, label_slug, release_label_slug,
                   created_at, updated_at)
                values (:id, :kind, :source, :externalId, :hop, :parentId, :labelSlug,
                        :releaseLabelSlug, :createdAt, :updatedAt)
                on conflict (id) do update set
                  state = 'pending', cursor = 0, hop = 0,
                  parent_id = excluded.parent_id, label_slug = excluded.label_slug,
                  release_label_slug = coalesce(excluded.release_label_slug,
                                                crawl_frontier.release_label_slug),
                  updated_at = excluded.updated_at
                where (crawl_frontier.state = 'done'
                       and crawl_frontier.done_at < :watermark)
                   or (crawl_frontier.state = 'pending'
                       and (crawl_frontier.parent_id is not :parentId
                            or crawl_frontier.hop <> 0
                            or crawl_frontier.label_slug is not :labelSlug))`,
        },
        markCrawlNodeRepairStatement(nodeId, `crawl-replay-enqueue:${crypto.randomUUID()}`, {
          now,
          onlyIfPreviousStatementChanged: true,
        }),
      ]);
    } else {
      groups.push([
        {
          args,
          sql: `insert into crawl_frontier
                  (id, kind, source, external_id, hop, parent_id, label_slug, release_label_slug,
                   created_at, updated_at)
                values (:id, :kind, :source, :externalId, :hop, :parentId, :labelSlug,
                        :releaseLabelSlug, :createdAt, :updatedAt)
                on conflict (id) do nothing`,
        },
        markCrawlNodeRepairStatement(nodeId, `crawl-enqueue:${crypto.randomUUID()}`, {
          now,
          onlyIfPreviousStatementChanged: true,
        }),
      ]);
    }

    if (releaseLabelSlug !== null) {
      groups.push([
        {
          args: [releaseLabelSlug, now, nodeId],
          sql: `update crawl_frontier set release_label_slug = ?, updated_at = ?
                where id = ? and kind = 'release' and release_label_slug is null
                  and state in ('pending', 'failed')
                  and not exists (
                    select 1 from crawl_due_work
                    where crawl_due_work.node_id = crawl_frontier.id
                      and crawl_due_work.state = 'leased'
                  )`,
        },
        markCrawlNodeRepairStatement(nodeId, `crawl-release-label:${crypto.randomUUID()}`, {
          now,
          onlyIfPreviousStatementChanged: true,
        }),
      ]);
    }
  }
  const results = await batchDueWorkMutationGroups(db, groups, MAX_CRAWL_DUE_CHUNK_SIZE);
  return results.reduce(
    (count, group, index) =>
      insertGroups.has(index) ? count + (group[0]?.rowsAffected ?? 0) : count,
    0,
  );
}

async function forwardReplayWatermark(
  node: FrontierRow,
  client?: Pick<Client, "execute">,
): Promise<string | undefined> {
  if (node.source !== "musicbrainz" || node.cursor < 0) {
    return undefined;
  }

  const db = client ?? (await getDb());

  if (node.kind === "label" && node.done_at && node.label_slug) {
    const result = await db.execute({
      args: [node.label_slug, node.external_id, node.done_at],
      sql: `select scope_changed_at from labels
            where slug = ?
              and seed_state = 'enabled'
              and (mb_label_id is null or mb_label_id = ?)
              and scope_changed_at is not null
              and scope_changed_at > ?
            limit 1`,
    });

    return typedRows<{ scope_changed_at: string }>(result.rows)[0]?.scope_changed_at;
  }

  if (node.kind !== "artist") {
    return undefined;
  }

  const result = await db.execute({
    args: [node.external_id],
    sql: `select max(max(created_at, updated_at)) as watermark
          from artist_rules
          where artist_mbid = ? and verdict = 'allow'`,
  });
  const watermark = typedRows<{ watermark: string | null }>(result.rows)[0]?.watermark ?? null;

  return watermark && (!node.done_at || watermark > node.done_at) ? watermark : undefined;
}

async function applyForwardBrowse(
  node: FrontierRow,
  childHop: number,
  browse: MbReleaseBrowse | null,
  client?: CrawlDbClient,
): Promise<Expansion> {
  const replayWatermark = await forwardReplayWatermark(node, client);
  const releases = browseReleases(browse, node.kind === "label" && replayWatermark !== undefined);
  const enqueued = await enqueueReleaseNodes(node, releases, childHop, replayWatermark, client);

  const rawPageLength = browse?.releases?.length ?? 0;
  const consumed = node.cursor + rawPageLength;
  const total = browse?.["release-count"] ?? consumed;
  const hasMore = rawPageLength === BROWSE_PAGE_SIZE && consumed < total;

  return {
    ...EMPTY,
    enqueued,
    next: { cursor: hasMore ? consumed : 0, state: hasMore ? "pending" : "done" },
  };
}

async function applyRearmedBrowse(
  node: FrontierRow,
  childHop: number,
  provider: RearmedBrowseProviderData,
  client?: CrawlDbClient,
): Promise<Expansion> {
  const { offset, page, staleTotal } = provider;
  if (node.cursor === REARM_TAIL && staleTotal !== null && staleTotal <= 0) {
    return { ...EMPTY, next: { cursor: 0, state: "done" } };
  }
  const releases = browseReleases(page);
  const total = page?.["release-count"] ?? offset + releases.length;
  const enqueued = await enqueueReleaseNodes(node, releases, childHop, undefined, client);

  if (staleTotal !== null && total > staleTotal) {
    return {
      ...EMPTY,
      enqueued,
      next: { cursor: descendCursor(Math.max(0, total - BROWSE_PAGE_SIZE)), state: "pending" },
    };
  }

  if (enqueued === 0 || offset === 0) {
    return { ...EMPTY, enqueued, next: { cursor: 0, state: "done" } };
  }

  return {
    ...EMPTY,
    enqueued,
    next: { cursor: descendCursor(Math.max(0, offset - BROWSE_PAGE_SIZE)), state: "pending" },
  };
}

type LabelScopeEntry = { enabled: boolean; labelId: string };
type FoldScopeEntry = "ambiguous" | LabelScopeEntry;
type ScopeMemo = {
  enabledLabelFolds: Set<string>;
  globalAllow: Set<string>;
  globalBlock: Set<string>;
  labelAllow: Map<string, Set<string>>;
  labelBlock: Map<string, Set<string>>;
  labelByFold: Map<string, FoldScopeEntry>;
  labelByMbid: Map<string, LabelScopeEntry>;
};
type ArtistRuleMemoRow = {
  artist_mbid: string;
  label_id: string | null;

  verdict: "allow" | "block";
};
type ReleaseLabelScope = { enabled: boolean; labelId: string | null; rulesAllowed: boolean };
type ScopeDecision = "allow" | "block" | "default";

function addLabelRule(map: Map<string, Set<string>>, labelId: string, artistMbid: string): void {
  const artists = map.get(labelId) ?? new Set<string>();
  artists.add(artistMbid);
  map.set(labelId, artists);
}

async function getScopeMemo(client?: Pick<Client, "execute">): Promise<ScopeMemo> {
  const labels = await listLabels(undefined, client);
  const db = client ?? (await getDb());

  const result = await db.execute({
    args: [ARTIST_RULE_MEMO_LIMIT + 1],
    sql: `select artist_mbid, label_id, verdict from artist_rules
          where verdict in ('allow', 'block')
          order by id asc limit ?`,
  });
  const rules = typedRows<ArtistRuleMemoRow>(result.rows);

  if (rules.length > ARTIST_RULE_MEMO_LIMIT) {
    throw new Error(`artist rule memo exceeds ${ARTIST_RULE_MEMO_LIMIT} rows`);
  }

  const memo: ScopeMemo = {
    enabledLabelFolds: new Set<string>(),
    globalAllow: new Set<string>(),
    globalBlock: new Set<string>(),
    labelAllow: new Map<string, Set<string>>(),
    labelBlock: new Map<string, Set<string>>(),
    labelByFold: new Map<string, FoldScopeEntry>(),
    labelByMbid: new Map<string, LabelScopeEntry>(),
  };

  for (const label of labels) {
    const entry = { enabled: label.seedState === "enabled", labelId: label.id };
    const key = fold(label.name);

    if (label.mbLabelId) {
      memo.labelByMbid.set(label.mbLabelId, entry);
    }

    if (!key) {
      continue;
    }

    if (entry.enabled) {
      memo.enabledLabelFolds.add(key);
    }

    const previous = memo.labelByFold.get(key);
    memo.labelByFold.set(
      key,
      !previous
        ? entry
        : previous === "ambiguous" || previous.labelId !== label.id
          ? "ambiguous"
          : entry,
    );
  }

  for (const rule of rules) {
    const scoped =
      rule.verdict === "allow"
        ? { global: memo.globalAllow, label: memo.labelAllow }
        : rule.verdict === "block"
          ? { global: memo.globalBlock, label: memo.labelBlock }
          : null;

    if (!scoped) {
      continue;
    }

    if (!rule.label_id) {
      scoped.global.add(rule.artist_mbid);
      continue;
    }

    addLabelRule(scoped.label, rule.label_id, rule.artist_mbid);
  }

  return memo;
}

function releaseLabelScope(
  mbLabelId: null | string,
  labelName: null | string | undefined,
  memo: ScopeMemo,
): ReleaseLabelScope {
  const exact = mbLabelId ? memo.labelByMbid.get(mbLabelId) : undefined;

  if (exact) {
    return { ...exact, rulesAllowed: true };
  }

  const key = labelName ? fold(labelName) : "";
  const fallback = key ? memo.labelByFold.get(key) : undefined;

  if (fallback && fallback !== "ambiguous") {
    return { ...fallback, rulesAllowed: true };
  }

  if (fallback === "ambiguous") {
    logEvent("warn", "crawl.scope-ambiguous", { label: labelName ?? null, mbLabelId });

    return {
      enabled: memo.enabledLabelFolds.has(key),
      labelId: null,
      rulesAllowed: false,
    };
  }

  return { enabled: false, labelId: null, rulesAllowed: true };
}

function artistScopeVerdict(
  candidate: TrackCandidate,
  scope: ReleaseLabelScope,
  memo: ScopeMemo,
): ScopeDecision {
  const first = candidate.creditMbids.find((mbid): mbid is string => mbid !== null) ?? null;

  if (!first || !scope.rulesAllowed) {
    return "default";
  }

  if (scope.labelId) {
    if (memo.labelAllow.get(scope.labelId)?.has(first)) {
      return "allow";
    }
    if (memo.labelBlock.get(scope.labelId)?.has(first)) {
      return "block";
    }
  }

  if (memo.globalAllow.has(first)) {
    return "allow";
  }
  if (memo.globalBlock.has(first)) {
    return "block";
  }

  return "default";
}

function discogsIdsForRelease(release: MbReleaseDetail): {
  inMasterId: null | number;
  inReleaseId: null | number;
} {
  let inReleaseId: null | number = null;
  let inMasterId: null | number = null;

  for (const relation of release.relations ?? []) {
    const resource = relation.url?.resource;
    const parsed = relation.type === "discogs" && resource ? parseDiscogsUrl(resource) : undefined;

    if (parsed?.kind === "release") {
      inReleaseId = parsed.id;
    } else if (parsed?.kind === "master") {
      inMasterId = parsed.id;
    }
  }

  return { inMasterId, inReleaseId };
}

async function applyRelease(
  node: FrontierRow,
  maxHop: number,
  release: MbReleaseDetail | null,
  client?: CrawlDbClient,
): Promise<Expansion> {
  if (!release?.id) {
    return { ...EMPTY, next: { cursor: 0, note: "no MusicBrainz release", state: "skipped" } };
  }

  const { inMasterId, inReleaseId } = discogsIdsForRelease(release);

  const mbLabel = (release["label-info"] ?? []).find((info) => info.label?.name)?.label;
  const mbLabelName = mbLabel?.name;
  const mbLabelId = mbLabel?.id ?? null;
  const labelsDiscovered: string[] = [];

  let labelName = mbLabelName;

  if (mbLabelName && labelSlug(mbLabelName)) {
    const known = await canonicalLabelRow(mbLabelName, client);

    if (known) {
      labelName = known.name;

      if (mbLabelId && !known.mbLabelId) {
        await adoptLabelMbLabelId(known.id, mbLabelId, client);
      }
    } else if (mbLabelId) {
      await ensureLabel(mbLabelName, mbLabelId, client);
      labelsDiscovered.push(mbLabelName);
    } else {
      logEvent("info", "crawl.label-discovery-unidentified", { name: mbLabelName });
    }
  }

  const coverUrl =
    release["cover-art-archive"]?.front === true
      ? `https://coverartarchive.org/release/${release.id}/front-500`
      : null;

  const candidates: TrackCandidate[] = [];
  const artistMbids = new Set<string>();

  const collectReleaseCandidates = (): void => {
    for (const medium of release.media ?? []) {
      for (const track of medium.tracks ?? []) {
        const recording = track.recording;
        const title = recording?.title ?? track.title;

        if (!recording?.id || !title) {
          continue;
        }

        const credits = recording["artist-credit"] ?? release["artist-credit"] ?? [];

        const named = credits
          .map((credit) => ({
            mbid: credit.artist?.id ?? null,
            name: credit.artist?.name ?? credit.name,
          }))
          .filter((credit): credit is { mbid: null | string; name: string } =>
            Boolean(credit.name),
          );
        const artists = named.map((credit) => credit.name);

        for (const credit of named) {
          if (credit.mbid && credit.mbid !== VARIOUS_ARTISTS_MBID) {
            artistMbids.add(credit.mbid);
          }
        }

        candidates.push({
          album: release.title ?? null,
          albumImageUrl: coverUrl,
          artists: artists.length > 0 ? artists : ["Unknown"],

          creditMbids:
            artists.length > 0
              ? named.map((credit) =>
                  credit.mbid && credit.mbid !== VARIOUS_ARTISTS_MBID ? credit.mbid : null,
                )
              : [null],

          durationMs: recording.length ?? track.length ?? 0,
          inMasterId,
          inReleaseId,
          isrc: recording.isrcs?.[0] ?? null,
          label: labelName ?? null,
          recordingId: recording.id,
          releaseDate: release.date ?? null,
          title,
        });
      }
    }
  };

  collectReleaseCandidates();

  const memo = await getScopeMemo(client);
  const scope = releaseLabelScope(mbLabelId, mbLabelName ?? labelName, memo);
  const labelCanAllow = scope.labelId ? (memo.labelAllow.get(scope.labelId)?.size ?? 0) > 0 : false;
  const canAllow = scope.rulesAllowed && (memo.globalAllow.size > 0 || labelCanAllow);
  const kept: TrackCandidate[] = [];
  let tracksAllowedIn = 0;
  let tracksSkippedArtistRule = 0;
  let tracksSkippedLabelGate = 0;

  const applyStorageGate = (): void => {
    if (!scope.enabled && !canAllow) {
      tracksSkippedLabelGate = candidates.length;
    } else {
      for (const candidate of candidates) {
        const verdict = artistScopeVerdict(candidate, scope, memo);

        if (verdict === "block") {
          tracksSkippedArtistRule += 1;
        } else if (verdict === "allow") {
          kept.push(candidate);
          tracksAllowedIn += scope.enabled ? 0 : 1;
        } else if (scope.enabled) {
          kept.push(candidate);
        } else {
          tracksSkippedLabelGate += 1;
        }
      }
    }
  };

  applyStorageGate();

  let tracksSkippedHeld = 0;
  let written = 0;

  if (kept.length > 0) {
    const albumId =
      (await ensureAlbum(release.title ?? null, release["release-group"]?.id ?? null, client)) ??
      null;

    const result = await writeCatalogueTracks(kept, albumId, client);
    tracksSkippedHeld = result.skipped;
    written = result.written;
    const { writtenIds } = result;

    if (labelName) {
      await linkTracksToLabel(writtenIds, labelName, mbLabelId, client);
    }

    await linkTracksToAlbumId(writtenIds, albumId, client);

    await linkTracksToArtistEntities(
      writtenIds,
      new Map(
        kept.map((candidate) => [catalogueTrackId(candidate.recordingId), candidate.creditMbids]),
      ),
      client,
    );

    await stampRemixerRoles(writtenIds, client);
  }

  const artistHop = node.hop + 1;
  const enqueued =
    artistHop <= maxHop
      ? await enqueueMany(
          [...artistMbids].map((mbid) => ({
            externalId: mbid,
            hop: artistHop,
            kind: "artist",
            labelSlug: node.label_slug,
            parentId: node.id,
            source: "musicbrainz",
          })),
          client,
        )
      : 0;

  return {
    enqueued,
    labelsDiscovered,
    next: {
      cursor: 0,
      note: `stored=${written} skipped_held=${tracksSkippedHeld} skipped_label=${tracksSkippedLabelGate} skipped_rule=${tracksSkippedArtistRule}`,
      state: "done",
    },
    tracksAllowedIn,
    tracksFound: candidates.length,
    tracksSkipped: tracksSkippedHeld + tracksSkippedLabelGate + tracksSkippedArtistRule,
    tracksSkippedArtistRule,
    tracksSkippedHeld,
    tracksSkippedLabelGate,
    tracksWritten: written,
  };
}

async function applyCrawlProvider(
  node: FrontierRow,
  maxHop: number,
  plan: CrawlProviderPlan,
  outcome: CrawlProviderOutcome,
  client?: CrawlDbClient,
): Promise<Expansion> {
  if (outcome.kind === "failed") {
    const error = outcome.rateLimited
      ? new ThrottledError(outcome.message)
      : new Error(outcome.message);
    throw error;
  }
  if (plan.kind === "terminal" && outcome.data.kind === "terminal") {
    return plan.expansion;
  }
  if (plan.kind === "skip-disabled" && outcome.data.kind === "terminal") {
    return (await disabledTerminalRelease(node, client))
      ? {
          ...EMPTY,
          next: { cursor: 0, note: "disabled own label at terminal hop", state: "skipped" },
        }
      : { ...EMPTY, next: { cursor: 0, note: "scope changed before skip", state: "pending" } };
  }
  if (plan.kind === "seed" && outcome.data.kind === "seed") {
    return applySeedLabel(node, plan, outcome.data.search, client);
  }
  if (plan.kind === "browse-forward" && outcome.data.kind === "browse-forward") {
    return applyForwardBrowse(node, plan.childHop, outcome.data.browse, client);
  }
  if (plan.kind === "browse-rearmed" && outcome.data.kind === "browse-rearmed") {
    return applyRearmedBrowse(node, plan.childHop, outcome.data.browse, client);
  }
  if (plan.kind === "release" && outcome.data.kind === "release") {
    return applyRelease(node, maxHop, outcome.data.release, client);
  }
  throw new Error("Crawl provider result does not match its prepared node");
}

async function expandNode(node: FrontierRow, maxHop: number): Promise<Expansion> {
  const plan = await planCrawlNode(node, maxHop);
  const data = await fetchCrawlProvider(plan, node);
  return applyCrawlProvider(node, maxHop, plan, { data, kind: "success" });
}

const CRAWL_PHASE_TOKEN_KEY_LABEL = "fluncle/catalogue-crawl-phase/v1";
export const CRAWL_PHASE_TOKEN_MAX_BYTES = 2 * 1024 * 1024;
const CRAWL_PHASE_CLOCK_SKEW_MS = 5 * 60 * 1000;

type PreparedCrawlPhaseToken = {
  claimToken: string;
  expiresAt: number;
  iat: number;
  maxHop: number;
  node: ClaimedCrawlFrontierRow;
  plan: CrawlProviderPlan;
  stage: "prepared";
};

type FetchedCrawlPhaseToken = Omit<PreparedCrawlPhaseToken, "stage"> & {
  outcome: CrawlProviderOutcome;
  stage: "fetched";
};

export type CrawlPhaseInitialization = Pick<
  CrawlPass,
  "artistsRearmed" | "releasesRearmed" | "seeded" | "seedsRearmed"
>;

export type CrawlPhaseCapabilities = {
  commitBatchLimit: number;
  commitBatchMaxTotalBytes: number;
};

export type CrawlPhasePrepareResult = {
  boxFetch: boolean;
  capabilities?: CrawlPhaseCapabilities;
  frontierPending: number;
  initialization: CrawlPhaseInitialization;
  items: {
    fetchPlan: CrawlFetchPlan;
    nodeId: string;
    nodeKind: CrawlNodeKind;
    preparedToken: string;
  }[];
  kind: "drained" | "prepared" | "unavailable";
  storableReady: boolean | null;
};

export const CRAWL_PHASE_CAPABILITIES: CrawlPhaseCapabilities = {
  commitBatchLimit: MAX_CRAWL_COMMIT_BATCH,
  commitBatchMaxTotalBytes: CRAWL_COMMIT_BATCH_MAX_TOTAL_BYTES,
};

export type CrawlPhaseFetchResult = {
  commitToken: string;
  operationId: "catalogue.crawl";
  operationKey: string;
  rateLimited?: boolean;
  requestDigest: string;
};

function crawlPhaseTokenKey(): Promise<Buffer> {
  return readEnv("ADMIN_SESSION_SECRET").then((secret) =>
    createHmac("sha256", secret).update(CRAWL_PHASE_TOKEN_KEY_LABEL).digest(),
  );
}

async function signCrawlPhaseToken(
  payload: FetchedCrawlPhaseToken | PreparedCrawlPhaseToken,
): Promise<string> {
  const body = Buffer.from(canonicalOperationJson(crawlPhaseJsonValue(payload))).toString(
    "base64url",
  );
  const signature = createHmac("sha256", await crawlPhaseTokenKey())
    .update(body)
    .digest("base64url");
  const token = `${body}.${signature}`;
  if (Buffer.byteLength(token, "utf8") > CRAWL_PHASE_TOKEN_MAX_BYTES) {
    throw new Error(`crawl phase provider envelope exceeds ${CRAWL_PHASE_TOKEN_MAX_BYTES} bytes`);
  }
  return token;
}

function crawlPhaseJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(crawlPhaseJsonValue);
  }
  if (isRecord(value)) {
    const normalized: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        normalized[key] = crawlPhaseJsonValue(child);
      }
    }
    return normalized;
  }
  throw new Error("crawl phase token contains a non-JSON value");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validClaimedNode(value: unknown): value is ClaimedCrawlFrontierRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.external_id === "string" &&
    typeof value.source_version === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.claim_expires_at === "string" &&
    (value.kind === "artist" || value.kind === "label" || value.kind === "release") &&
    (value.source === "fluncle" || value.source === "musicbrainz") &&
    Number.isSafeInteger(value.cursor) &&
    Number.isSafeInteger(value.failures) &&
    Number.isSafeInteger(value.hop)
  );
}

async function verifyCrawlPhaseToken<T extends FetchedCrawlPhaseToken | PreparedCrawlPhaseToken>(
  token: string,
  stage: T["stage"],
  enforceExpiry = true,
): Promise<T> {
  if (Buffer.byteLength(token, "utf8") > CRAWL_PHASE_TOKEN_MAX_BYTES) {
    throw new Error("invalid crawl phase token");
  }
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new Error("invalid crawl phase token");
  }
  const expected = createHmac("sha256", await crawlPhaseTokenKey())
    .update(body)
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("invalid crawl phase token");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid crawl phase token");
  }
  if (
    !isRecord(parsed) ||
    parsed.stage !== stage ||
    typeof parsed.claimToken !== "string" ||
    !Number.isSafeInteger(parsed.iat) ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    !Number.isSafeInteger(parsed.maxHop) ||
    !validClaimedNode(parsed.node) ||
    !isRecord(parsed.plan) ||
    (stage === "fetched" && !isRecord(parsed.outcome))
  ) {
    throw new Error("invalid crawl phase token");
  }
  const now = Date.now();
  if (
    Number(parsed.iat) > now + CRAWL_PHASE_CLOCK_SKEW_MS ||
    (enforceExpiry && Number(parsed.expiresAt) < now) ||
    Number(parsed.expiresAt) <= Number(parsed.iat)
  ) {
    throw new Error("expired crawl phase token");
  }
  return parsed as T;
}

function emptyCrawlPhaseInitialization(): CrawlPhaseInitialization {
  return { artistsRearmed: 0, releasesRearmed: 0, seeded: 0, seedsRearmed: 0 };
}

async function initializeCrawlPhaseState(
  cutoverEnabled: boolean,
): Promise<CrawlPhaseInitialization> {
  const seed = await seedFromEnabledLabels();
  const releasesRearmed = await rearmScopedLabelReleases();
  let artistsRearmed = await rearmAllowedArtists();
  const seedsRearmed = await rearmSeedLabels();
  if (!cutoverEnabled) {
    artistsRearmed += await rearmStaleAllowedArtists();
  }
  const initialization: CrawlPhaseInitialization = {
    artistsRearmed,
    releasesRearmed,
    seeded: seed.minted,
    seedsRearmed,
  };
  return initialization;
}

export async function initializeCrawlPhase(): Promise<
  CrawlPhaseInitialization & { kind: "initialized" | "unavailable" }
> {
  const cutoverEnabled = await isCrawlDueCutoverEnabled();
  if (!cutoverEnabled) {
    return { ...emptyCrawlPhaseInitialization(), kind: "unavailable" };
  }
  return { ...(await initializeCrawlPhaseState(true)), kind: "initialized" };
}

async function storableReleaseReady(db: Pick<Client, "execute">): Promise<boolean> {
  const result = await db.execute(`select 1 from crawl_due_work
    indexed by crawl_due_work_release_ready_idx
    where state = 'ready' and node_kind = 'release' and storable_rank = 0 limit 1`);
  return result.rows.length > 0;
}

export async function prepareCrawlPhase({
  limit = 2,
  maxHop = DEFAULT_MAX_HOP,
}: {
  limit?: number;
  maxHop?: number;
} = {}): Promise<CrawlPhasePrepareResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CRAWL_PREPARE_LIMIT) {
    throw new Error(
      `crawl prepare limit must be an integer from 1 through ${MAX_CRAWL_PREPARE_LIMIT}`,
    );
  }
  const boxFetch = await isCrawlBoxFetchEnabled();
  if (!(await isCrawlDueCutoverEnabled())) {
    return {
      boxFetch,
      frontierPending: await countFrontierPending(),
      initialization: emptyCrawlPhaseInitialization(),
      items: [],
      kind: "unavailable",
      storableReady: null,
    };
  }

  await rearmSkippedDisabledReleases(maxHop);

  const db = await getDb();
  const claimed = await claimCrawlFrontierRows(db, {
    claimedBy: CRAWL_CATALOGUE_CLAIM_OWNER,
    leaseMs: CRAWL_CATALOGUE_LEASE_MS,
    limit,
    token: crypto.randomUUID(),
  });
  if (claimed.rows.length === 0) {
    return {
      boxFetch,
      frontierPending: await countFrontierPending(),
      initialization: {
        ...emptyCrawlPhaseInitialization(),
        artistsRearmed: claimed.artistsRearmed,
      },
      items: [],
      kind: "drained",
      storableReady: false,
    };
  }

  const hopLimit = Math.max(0, Math.min(maxHop, MAX_HOP_CEILING));
  const items: CrawlPhasePrepareResult["items"] = [];
  for (const claimedNode of claimed.rows) {
    const plan = await planCrawlNode(claimedNode, hopLimit, db);
    items.push({
      fetchPlan: crawlFetchPlan(plan, claimedNode),
      nodeId: claimedNode.id,
      nodeKind: claimedNode.kind,
      preparedToken: await signCrawlPhaseToken({
        claimToken: claimed.claimToken,
        expiresAt: Date.parse(claimedNode.claim_expires_at),
        iat: Date.now(),
        maxHop: hopLimit,
        node: claimedNode,
        plan,
        stage: "prepared",
      }),
    });
  }
  return {
    boxFetch,
    capabilities: CRAWL_PHASE_CAPABILITIES,
    frontierPending: await countFrontierPending(),
    initialization: {
      ...emptyCrawlPhaseInitialization(),
      artistsRearmed: claimed.artistsRearmed,
    },
    items,
    kind: "prepared",
    storableReady: await storableReleaseReady(db),
  };
}

function crawlCommitCoordinates(commitToken: string): Promise<{
  operationId: "catalogue.crawl";
  operationKey: string;
  requestDigest: string;
}> {
  const operationId = "catalogue.crawl" as const;
  const tokenDigest = createHash("sha256").update(commitToken).digest("hex");
  return digestOperationRequest({ commitToken }).then((requestDigest) => ({
    operationId,
    operationKey: `${operationId}:${tokenDigest}`,
    requestDigest,
  }));
}

export async function fetchCrawlPhase(
  preparedToken: string,
  supplied?: readonly SuppliedCrawlBody[],
): Promise<CrawlPhaseFetchResult> {
  const prepared = await verifyCrawlPhaseToken<PreparedCrawlPhaseToken>(preparedToken, "prepared");

  const accepted =
    supplied !== undefined && supplied.length > 0 && (await isCrawlBoxFetchEnabled())
      ? suppliedCrawlBodies(prepared.plan, prepared.node, supplied)
      : undefined;
  let outcome: CrawlProviderOutcome;
  try {
    outcome = {
      data: await fetchCrawlProvider(
        prepared.plan,
        prepared.node,
        accepted === undefined ? mb : suppliedCrawlProviderTransport(accepted, mb),
      ),
      kind: "success",
    };
  } catch (error) {
    outcome = {
      kind: "failed",
      message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      rateLimited: error instanceof ThrottledError,
    };
  }

  const fetched = { ...prepared, outcome, stage: "fetched" as const };
  let commitToken: string;
  try {
    commitToken = await signCrawlPhaseToken(fetched);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("provider envelope exceeds")) {
      throw error;
    }
    commitToken = await signCrawlPhaseToken({
      ...prepared,
      outcome: {
        kind: "failed",
        message: "MusicBrainz response exceeded the bounded crawl provider envelope",
        rateLimited: false,
      },
      stage: "fetched",
    });
  }
  return {
    commitToken,
    ...(await crawlCommitCoordinates(commitToken)),
    rateLimited: outcome.kind === "failed" && outcome.rateLimited,
  };
}

function expansionResult(expansion: Expansion, plan: CrawlProviderPlan): JsonValue {
  return {
    expanded: 1,
    failed: 0,
    labelsDiscovered: expansion.labelsDiscovered,
    nodesEnqueued: expansion.enqueued,
    rateLimited: false,
    releaseDetailsStored: plan.kind === "release" && expansion.tracksWritten > 0 ? 1 : 0,
    tracksAllowedIn: expansion.tracksAllowedIn,
    tracksFound: expansion.tracksFound,
    tracksSkipped: expansion.tracksSkipped,
    tracksSkippedArtistRule: expansion.tracksSkippedArtistRule,
    tracksSkippedHeld: expansion.tracksSkippedHeld,
    tracksSkippedLabelGate: expansion.tracksSkippedLabelGate,
    tracksWritten: expansion.tracksWritten,
  };
}

export async function commitCrawlPhase(
  options: CrawlPhaseFetchResult,
): Promise<OperationReceiptOutcome> {
  const fetched = await verifyCrawlPhaseToken<FetchedCrawlPhaseToken>(
    options.commitToken,
    "fetched",
    false,
  );
  const coordinates = await crawlCommitCoordinates(options.commitToken);
  if (
    options.operationId !== coordinates.operationId ||
    options.operationKey !== coordinates.operationKey ||
    options.requestDigest !== coordinates.requestDigest
  ) {
    throw new Error("crawl phase operation coordinates do not match the signed provider result");
  }

  return executeReceiptBackedOperation({
    client: await getDb(),
    effect: async (transaction): Promise<OperationReceiptEffectResult> => {
      const current = await isClaimedCrawlFrontierRowCurrent(
        transaction,
        fetched.node,
        fetched.claimToken,
      );
      if (!current) {
        return {
          result: { code: "stale_crawl_claim", nodeId: fetched.node.id },
          resultIdentity: fetched.node.id,
          state: "rejected",
        };
      }

      if (fetched.outcome.kind === "failed") {
        const settled = await settleClaimedCrawlFrontierRow(transaction, {
          claimToken: fetched.claimToken,
          id: fetched.node.id,
          ...(fetched.outcome.rateLimited
            ? throttledSettlement(fetched.node)
            : {
                cursor: fetched.node.cursor,
                failures: fetched.node.failures + 1,
                note: fetched.outcome.message.slice(0, 200),
                state: "failed" as const,
              }),
        });
        if (!settled) {
          throw new Error("crawl claim changed while its provider failure was settling");
        }
        return {
          result: {
            expanded: 0,
            failed: 1,
            labelsDiscovered: [],
            nodesEnqueued: 0,
            rateLimited: fetched.outcome.rateLimited,
            tracksAllowedIn: 0,
            tracksFound: 0,
            tracksSkipped: 0,
            tracksSkippedArtistRule: 0,
            tracksSkippedHeld: 0,
            tracksSkippedLabelGate: 0,
            tracksWritten: 0,
          },
          resultIdentity: fetched.node.id,
          state: "committed",
        };
      }

      const expansion = await applyCrawlProvider(
        fetched.node,
        fetched.maxHop,
        fetched.plan,
        fetched.outcome,
        transaction,
      );
      const settled = await settleClaimedCrawlFrontierRow(transaction, {
        claimToken: fetched.claimToken,
        cursor: expansion.next.cursor,
        id: fetched.node.id,
        note: expansion.next.note,
        state: expansion.next.state,
      });
      if (!settled) {
        throw new Error("crawl claim changed while its provider result was settling");
      }
      return {
        result: expansionResult(expansion, fetched.plan),
        resultIdentity: fetched.node.id,
        state: "committed",
      };
    },
    ...coordinates,
  });
}

export const CRAWL_COMMIT_BATCH_WALL_BUDGET_MS = 45_000;

export type CrawlCommitBatchItem = CrawlPhaseFetchResult;

export type CrawlCommitBatchReceipt = {
  elapsedMs?: number;
  error?: string;
  operationKey: string;
  outcome:
    | "committed"
    | "conflict"
    | "failed"
    | "in-progress"
    | "lookup-failed"
    | "rejected"
    | "safely-retryable";
  replayed: boolean;
  result?: JsonValue;
  resultIdentity?: string;
  state?: "accepted" | "committed" | "rejected";
};

export type CrawlCommitBatchResult = {
  deferred: number;
  receipts: CrawlCommitBatchReceipt[];
};

export async function commitCrawlNodes(
  items: readonly CrawlCommitBatchItem[],
  options: {
    commit?: (item: CrawlCommitBatchItem) => Promise<OperationReceiptOutcome>;
    now?: () => number;
    wallBudgetMs?: number;
  } = {},
): Promise<CrawlCommitBatchResult> {
  if (items.length === 0 || items.length > MAX_CRAWL_COMMIT_BATCH) {
    throw new Error(`crawl commit batches must carry 1 through ${MAX_CRAWL_COMMIT_BATCH} nodes`);
  }
  const totalBytes = items.reduce(
    (sum, item) => sum + Buffer.byteLength(item.commitToken, "utf8"),
    0,
  );
  if (totalBytes > CRAWL_COMMIT_BATCH_MAX_TOTAL_BYTES) {
    throw new ApiError(
      "crawl_commit_batch_too_large",
      `A crawl commit batch may carry at most ${CRAWL_COMMIT_BATCH_MAX_TOTAL_BYTES} bytes of signed provider envelopes.`,
      413,
    );
  }

  const now = options.now ?? (() => performance.now());
  const budgetMs = options.wallBudgetMs ?? CRAWL_COMMIT_BATCH_WALL_BUDGET_MS;
  const startedAt = now();
  const receipts: CrawlCommitBatchReceipt[] = [];
  let deferred = 0;

  for (const [index, item] of items.entries()) {
    if (index > 0 && now() - startedAt >= budgetMs) {
      deferred += 1;
      receipts.push({
        elapsedMs: 0,
        operationKey: item.operationKey,
        outcome: "safely-retryable",
        replayed: false,
      });
      continue;
    }
    const itemStartedAt = now();
    try {
      const receipt = await (options.commit ?? commitCrawlPhase)(item);
      receipts.push({
        elapsedMs: Math.max(0, Math.round(now() - itemStartedAt)),
        operationKey: item.operationKey,
        ...receipt,
      });
    } catch (error) {
      receipts.push({
        elapsedMs: Math.max(0, Math.round(now() - itemStartedAt)),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        operationKey: item.operationKey,
        outcome: "failed",
        replayed: false,
      });
    }
  }

  return { deferred, receipts };
}

export async function crawlCatalogue({
  dryRun = false,
  limit = 10,
  maxHop = DEFAULT_MAX_HOP,
}: {
  dryRun?: boolean;
  limit?: number;
  maxHop?: number;
} = {}): Promise<CrawlPass> {
  const hopLimit = Math.max(0, Math.min(maxHop, MAX_HOP_CEILING));
  const pass: CrawlPass = {
    artistsRearmed: 0,
    dryRun,
    expanded: 0,
    failed: 0,
    frontierPending: 0,
    labelsDiscovered: [],
    maxHop: hopLimit,
    nodesEnqueued: 0,
    rateLimited: false,
    releaseDetailsStored: 0,
    releasesRearmed: 0,
    seeded: 0,
    seedsRearmed: 0,
    tracksAllowedIn: 0,
    tracksFound: 0,
    tracksSkipped: 0,
    tracksSkippedArtistRule: 0,
    tracksSkippedHeld: 0,
    tracksSkippedLabelGate: 0,
    tracksWritten: 0,
  };

  if (dryRun) {
    const enabled = await listLabels("enabled");

    return { ...pass, frontierPending: await countFrontierPending(), seeded: enabled.length };
  }

  const cutoverEnabled = await isCrawlDueCutoverEnabled();
  const initialization = await initializeCrawlPhaseState(cutoverEnabled);
  await rearmSkippedDisabledReleases(hopLimit);
  pass.seeded = initialization.seeded;
  pass.releasesRearmed = initialization.releasesRearmed;
  pass.artistsRearmed = initialization.artistsRearmed;
  pass.seedsRearmed = initialization.seedsRearmed;
  const claimToken = cutoverEnabled ? crypto.randomUUID() : undefined;
  const claimed =
    cutoverEnabled && claimToken !== undefined
      ? await claimCrawlFrontierRows(await getDb(), {
          claimedBy: CRAWL_CATALOGUE_CLAIM_OWNER,
          leaseMs: CRAWL_CATALOGUE_LEASE_MS,
          limit,
          token: claimToken,
        })
      : undefined;
  pass.artistsRearmed += claimed?.artistsRearmed ?? 0;
  const nodes: FrontierRow[] = claimed?.rows ?? (await pickNodes(limit));

  const settleNode = async (
    node: FrontierRow,
    state: CrawlNodeState,
    patch: { cursor?: number; failures?: number; note?: string },
  ): Promise<boolean> => {
    if (claimed === undefined) {
      await settle(node.id, state, patch);
      return true;
    }
    return settleClaimedCrawlFrontierRow(await getDb(), {
      claimToken: claimed.claimToken,
      id: node.id,
      state,
      ...patch,
    });
  };

  for (const node of nodes) {
    let expansion: Expansion;
    try {
      expansion = await expandNode(node, hopLimit);
    } catch (error) {
      const throttled = error instanceof ThrottledError;

      const { state: throttledState, ...throttledPatch } = throttledSettlement(node);
      const settled = throttled
        ? await settleNode(node, throttledState, throttledPatch)
        : await settleNode(node, "failed", {
            cursor: node.cursor,
            failures: node.failures + 1,
            note: String(error).slice(0, 200),
          });

      if (!settled) {
        continue;
      }
      pass.failed += 1;

      logEvent(throttled ? "warn" : "error", "crawl.node-failed", {
        error,
        kind: node.kind,
        node: node.id,
      });

      if (throttled) {
        pass.rateLimited = true;
        break;
      }
      continue;
    }

    const settled = await settleNode(node, expansion.next.state, {
      cursor: expansion.next.cursor,
      note: expansion.next.note,
    });

    if (!settled) {
      continue;
    }

    pass.expanded += 1;
    pass.nodesEnqueued += expansion.enqueued;
    pass.tracksAllowedIn += expansion.tracksAllowedIn;
    pass.tracksFound += expansion.tracksFound;
    pass.tracksWritten += expansion.tracksWritten;
    if (node.kind === "release" && expansion.tracksWritten > 0) {
      pass.releaseDetailsStored += 1;
    }
    pass.tracksSkippedArtistRule += expansion.tracksSkippedArtistRule;
    pass.tracksSkippedHeld += expansion.tracksSkippedHeld;
    pass.tracksSkippedLabelGate += expansion.tracksSkippedLabelGate;
    pass.tracksSkipped += expansion.tracksSkipped;
    pass.labelsDiscovered.push(...expansion.labelsDiscovered);
  }

  pass.frontierPending = await countFrontierPending();

  return pass;
}

export type FrontierCounts = {
  frontier: { done: number; failed: number; pending: number; skipped: number };
};

export type FrontierByKind = { artist: number; label: number; release: number };

export async function getFrontierCounts(): Promise<FrontierCounts> {
  const db = await getDb();
  const states = await db.execute("select state, count(*) as n from crawl_frontier group by state");
  const frontier = { done: 0, failed: 0, pending: 0, skipped: 0 };

  for (const row of typedRows<{ n: number; state: CrawlNodeState }>(states.rows)) {
    frontier[row.state] = Number(row.n);
  }

  return { frontier };
}

export async function getFrontierByKind(): Promise<FrontierByKind> {
  const db = await getDb();
  const kinds = await db.execute("select kind, count(*) as n from crawl_frontier group by kind");
  const frontierByKind: FrontierByKind = { artist: 0, label: 0, release: 0 };

  for (const row of typedRows<{ kind: CrawlNodeKind; n: number }>(kinds.rows)) {
    frontierByKind[row.kind] = Number(row.n);
  }

  return frontierByKind;
}

export async function countFrontierPending(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "select count(*) as n from crawl_frontier where state = 'pending'",
  );

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

export async function getCrawlStatus(): Promise<CrawlStatus> {
  const db = await getDb();
  const [
    frontierCounts,
    frontierByKind,
    catalogue,
    anchors,
    storable,
    unstorable,
    undecidedQueued,
    labels,
  ] = await Promise.all([
    getFrontierCounts(),
    getFrontierByKind(),

    db.execute(`select (select count(*) from tracks) - (select count(*) from findings) as n`),

    db.execute(`select count(*) as n from tracks indexed by tracks_anchor_queue_idx
                where isrc is not null and spotify_uri is null
                  and not exists (select 1 from findings where findings.track_id = tracks.track_id)`),

    db.execute(`select count(*) as n from crawl_due_work indexed by crawl_due_work_release_ready_idx
                where state = 'ready' and node_kind = 'release' and storable_rank = 0`),

    db.execute(`select count(*) as n from crawl_due_work indexed by crawl_due_work_release_ready_idx
                where state = 'ready' and node_kind = 'release' and storable_rank = 1`),

    db.execute(`select count(*) as n from labels l
                where l.seed_state = 'undecided'
                  and exists (select 1 from crawl_due_work d where d.label_slug = l.slug)`),
    listLabels(),
  ]);

  return {
    anchorsPending: Number(typedRows<{ n: number }>(anchors.rows)[0]?.n ?? 0),
    catalogueTracks: Number(typedRows<{ n: number }>(catalogue.rows)[0]?.n ?? 0),
    frontier: frontierCounts.frontier,
    frontierByKind,
    labelsUndecided: labels.filter((label) => label.seedState === "undecided").length,
    seedLabels: labels
      .filter((label) => label.seedState === "enabled")
      .map((label) => label.name)
      .sort(),
    storablePending: Number(typedRows<{ n: number }>(storable.rows)[0]?.n ?? 0),
    undecidedLabelsQueued: Number(typedRows<{ n: number }>(undecidedQueued.rows)[0]?.n ?? 0),
    unstorablePending: Number(typedRows<{ n: number }>(unstorable.rows)[0]?.n ?? 0),
  };
}
