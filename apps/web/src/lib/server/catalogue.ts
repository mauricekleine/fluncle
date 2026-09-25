import { createHash } from "node:crypto";
import { type InStatement } from "@libsql/client/web";
import { CAPTURE_TIER, type CapturePriorityKind } from "../capture-tier";
import { DUPLICATE_SIMILARITY, LONG_FORM_MS } from "../catalogue-eligibility";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import {
  batchDueWorkSourceMutation,
  countDueWorkNow,
  dueWorkCatalogueRankRepairSubjects,
  DueWorkMaintenancePendingError,
  MAX_DUE_WORK_CHUNK_SIZE,
  markDueWorkSourceMaintenanceFromSelectStatements,
} from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { CLEAR_EMBEDDING_SQL, clearEmbeddingSatellite } from "./embedding";
import { repairRankableArtistsForTrackStatement } from "./hub-counts";
import { labelSlug } from "./labels";
import { readQualifiedArtistIds } from "./public-projection-cutover";
import { getSetting, setSetting } from "./settings";
import { matchKey, normalizeIsrc } from "./track-match";

export type CapturePriorityReason = {
  kind: CapturePriorityKind;
  name: string | null;
};

export const DUPLICATE_CAPTURE_TIER = -2;

export { CAPTURE_TIER, CAPTURE_TIER_LABELS, captureTierLabelFor } from "../capture-tier";
export type { CapturePriorityKind } from "../capture-tier";

export { DUPLICATE_SIMILARITY } from "../catalogue-eligibility";

export { LONG_FORM_MS } from "../catalogue-eligibility";

export const MIN_TRACK_MS = 60_000;

export const WRONG_AUDIO_QUARANTINE = 0.9995;

export const EAR_DIVERSITY_DECAY = { artist: 0.97, key: 0.99, year: 0.985 } as const;

export const WRONG_AUDIO_STATUS = "wrong-audio";

export const QUARANTINE_CLEARED = "quarantine-cleared";

export const DUPLICATE_CLEARED = "duplicate-cleared";

type RejectedSource = { at: string; reason: string; sha256: string; videoId?: string };

const REJECTED_MEMORY_CAP = 10;

function shaFromSourceAudioKey(key: null | string): null | string {
  if (!key) {
    return null;
  }

  const base = key.split("/").pop() ?? "";
  const dot = base.indexOf(".");
  const hash = (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();

  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function parseRejectedSources(value: null | string): RejectedSource[] {
  if (!value) {
    return [];
  }

  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  const out: RejectedSource[] = [];

  for (const entry of raw) {
    const row = entry as Partial<RejectedSource> | null;

    if (row && typeof row.sha256 === "string" && typeof row.at === "string") {
      out.push({
        at: row.at,
        reason: typeof row.reason === "string" ? row.reason : "rejected",
        sha256: row.sha256,
        ...(typeof row.videoId === "string" ? { videoId: row.videoId } : {}),
      });
    }
  }

  return out;
}

function appendRejectedSha(
  existing: null | string,
  sha: null | string,
  reason: string,
  now: string,
): null | string {
  if (!sha) {
    return existing;
  }

  const prior = parseRejectedSources(existing).filter((row) => row.sha256 !== sha);
  const next: RejectedSource[] = [...prior, { at: now, reason, sha256: sha }].slice(
    -REJECTED_MEMORY_CAP,
  );

  return JSON.stringify(next);
}

export type ArchiveAffinity = {
  disabledLabels: Set<string>;

  findingArtists: Set<string>;

  findingLabels: Set<string>;

  qualifiedArtists: Set<string>;

  seedLabels: Set<string>;
};

export type CaptureCandidate = { artistIds: string[]; artists: string[]; label: string | null };

export function capturePriorityFor(
  candidate: CaptureCandidate,
  archive: ArchiveAffinity,
): { priority: number; reason: CapturePriorityReason } {
  const slug = labelSlug(candidate.label);

  if (slug && candidate.label && archive.disabledLabels.has(slug)) {
    return {
      priority: CAPTURE_TIER["skipped-label"],
      reason: { kind: "skipped-label", name: candidate.label },
    };
  }

  const enabledLabel = Boolean(slug && candidate.label && archive.seedLabels.has(slug));
  const qualifiedArtist = candidate.artistIds.some((id) => archive.qualifiedArtists.has(id));

  if (!qualifiedArtist && !enabledLabel) {
    return { priority: CAPTURE_TIER.unauthorized, reason: { kind: "unauthorized", name: null } };
  }

  const nameOnFinding = candidate.artists.find((artist) =>
    archive.findingArtists.has(artist.trim().toLowerCase()),
  );

  if (qualifiedArtist || nameOnFinding !== undefined) {
    const named = nameOnFinding ?? candidate.artists[0] ?? null;

    return { priority: CAPTURE_TIER.artist, reason: { kind: "artist", name: named } };
  }

  if (slug && candidate.label) {
    if (archive.findingLabels.has(slug)) {
      return { priority: CAPTURE_TIER.label, reason: { kind: "label", name: candidate.label } };
    }

    if (archive.seedLabels.has(slug)) {
      return {
        priority: CAPTURE_TIER["seed-label"],
        reason: { kind: "seed-label", name: candidate.label },
      };
    }
  }

  return { priority: CAPTURE_TIER.none, reason: { kind: "none", name: null } };
}

function ladderTierForRow(
  candidate: CaptureCandidate,
  archive: ArchiveAffinity,
  operatorAuthorized: boolean,
): { priority: number; reason: CapturePriorityReason } {
  const base = capturePriorityFor(candidate, archive);

  if (operatorAuthorized && base.reason.kind === "unauthorized") {
    return { priority: CAPTURE_TIER.none, reason: { kind: "none", name: null } };
  }

  return base;
}

const RANK_LOGIC_VERSION = "v6";

export const CATALOGUE_RANK_MATERIAL_REVISION_KEY = "catalogue_rank_material_revision";
export const CATALOGUE_RANK_MATERIAL_REVISION_INITIAL = "initial";

export function rankCorpus(
  findings: number,
  embeddedFindings: number,
  qualifiedArtists: number,
  qualifiedDigest: string,
  materialRevision: string,
): string {
  const materialDigest = createHash("sha256").update(materialRevision).digest("hex").slice(0, 16);
  return `${RANK_LOGIC_VERSION}:${findings}:${embeddedFindings}:${qualifiedArtists}:${qualifiedDigest}:${materialDigest}`;
}

export function catalogueRankCorpusForTrack(corpus: string, hasEmbedding: boolean): string {
  if (hasEmbedding || !corpus.startsWith(`${RANK_LOGIC_VERSION}:`)) {
    return corpus;
  }
  const separator = corpus.lastIndexOf(":");
  return separator < 0 ? corpus : `${corpus.slice(0, separator + 1)}unembedded`;
}

export function catalogueRankMaterialRevisionForFindingStatement(
  trackId: string,
  revision: string,
): Exclude<InStatement, string> {
  return {
    args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY, revision, trackId],
    sql: `insert into settings (key, value)
      select ?, ? where changes() > 0
        and exists (select 1 from findings where track_id = ?)
      on conflict(key) do update set value = excluded.value`,
  };
}

export function qualifiedArtistsDigest(sortedArtistIds: readonly string[]): string {
  return createHash("sha256").update(sortedArtistIds.join("\n")).digest("hex").slice(0, 16);
}

export type RankCatalogueSummary = {
  catalogueDuplicates: number;

  corpus: string;

  embeddedFindings: number;

  findings: number;

  prioritized: number;

  quarantined: number;

  remaining: number;

  scored: number;
};

export type CatalogueRankState = Pick<
  RankCatalogueSummary,
  "corpus" | "embeddedFindings" | "findings"
>;

export const CATALOGUE_RANK_STATE_KEY = "catalogue_rank_state_cache";

export function parseCatalogueRankState(value: string | undefined): CatalogueRankState | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<CatalogueRankState>;
    return typeof parsed.corpus === "string" &&
      Number.isSafeInteger(parsed.embeddedFindings) &&
      Number(parsed.embeddedFindings) >= 0 &&
      Number.isSafeInteger(parsed.findings) &&
      Number(parsed.findings) >= 0
      ? {
          corpus: parsed.corpus,
          embeddedFindings: Number(parsed.embeddedFindings),
          findings: Number(parsed.findings),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLiveCatalogueRankState(): Promise<CatalogueRankState> {
  const db = await getDb();
  const countResult = await db.execute({
    args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],

    sql: `select
            (select count(*) from findings) as findings,
            (select count(*) from findings cross join tracks ft on ft.track_id = findings.track_id
             where ft.has_embedding = 1) as embedded,
            coalesce((select value from settings where key = ?),
              '${CATALOGUE_RANK_MATERIAL_REVISION_INITIAL}') as material_revision`,
  });
  const counts = typedRows<{
    embedded: number;
    findings: number;
    material_revision: string;
  }>(countResult.rows)[0];
  const findings = Number(counts?.findings ?? 0);
  const embeddedFindings = Number(counts?.embedded ?? 0);
  const qualifiedArtistIds = await readQualifiedArtistIds(db, QUALIFIED_ARTISTS_SQL);
  const materialRevision = counts?.material_revision ?? CATALOGUE_RANK_MATERIAL_REVISION_INITIAL;

  return {
    corpus: rankCorpus(
      findings,
      embeddedFindings,
      qualifiedArtistIds.length,
      qualifiedArtistsDigest(qualifiedArtistIds),
      materialRevision,
    ),
    embeddedFindings,
    findings,
  };
}

async function persistCatalogueRankState(state: CatalogueRankState): Promise<void> {
  await setSetting(CATALOGUE_RANK_STATE_KEY, JSON.stringify(state));
}

export async function refreshCatalogueRankStateCache(): Promise<CatalogueRankState> {
  const state = await readLiveCatalogueRankState();
  await persistCatalogueRankState(state);
  return state;
}

export const RANK_BATCH_SIZE = 250;

type RankProjectionInputs = {
  capturePriority: null | number;
  captureStatus: null | string;
  duplicateOfTrackId: null | string;
  hasEmbedding: boolean;
  nearestFindingScore: null | number;

  observedDismissedAt: null | string;
  observedIsCatalogue: boolean;
  trackId: string;
};

function rankChangedSubjectSelection(chunk: readonly RankProjectionInputs[]): {
  args: (null | number | string)[];
  sql: string;
} {
  return {
    args: chunk.flatMap((row) => [
      row.trackId,
      row.capturePriority,
      row.duplicateOfTrackId,
      row.nearestFindingScore,
      row.captureStatus,
      row.hasEmbedding ? 1 : 0,
      row.observedIsCatalogue ? 1 : 0,
      row.observedDismissedAt,
    ]),

    sql: `select written.column1 as subject_id
      from (values ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}) as written
      join tracks on tracks.track_id = written.column1
      where tracks.capture_priority is not written.column2
         or tracks.duplicate_of_track_id is not written.column3
         or tracks.nearest_finding_score is not written.column4
         or tracks.capture_status is not written.column5
         or tracks.has_embedding is not written.column6
         or tracks.is_catalogue is not written.column7
         or tracks.dismissed_at is not written.column8`,
  };
}

function rankMaintenanceStatements(
  projected: readonly RankProjectionInputs[],
  now: string,
): InStatement[] {
  const maintenance: InStatement[] = [];
  for (let start = 0; start < projected.length; start += MAX_DUE_WORK_CHUNK_SIZE) {
    const chunk = projected.slice(start, start + MAX_DUE_WORK_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }
    maintenance.push(
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        rankChangedSubjectSelection(chunk),
        { now, producer: "catalogue-rank" },
      ),
    );
  }
  return maintenance;
}

function rankSettledStatements(movedIds: readonly string[], selectedAt: string): InStatement[] {
  const settled: InStatement[] = [];
  for (let start = 0; start < movedIds.length; start += MAX_DUE_WORK_CHUNK_SIZE) {
    const chunk = movedIds.slice(start, start + MAX_DUE_WORK_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }
    settled.push({
      args: [selectedAt, ...chunk],
      sql: `delete from due_work
        where work_kind = 'catalogue-rank' and subject_type = 'track'
          and updated_at < ?
          and subject_id in (${chunk.map(() => "?").join(", ")})`,
    });
  }
  return settled;
}

const RANK_MORE_REMAIN = 1;

type CandidateRow = {
  artists_json: string;
  capture_status: string | null;

  dismissed_at: string | null;
  has_vector: number;
  is_catalogue: number;
  isrc: string | null;
  label: string | null;

  source_audio_key: string | null;
  source_audio_rejected: string | null;
  title: string;
  track_id: string;
};

type WinnerRow = { cid: string; dist: number; fid: string };

function preAudioPriority(
  candidate: {
    artists_json: string;
    capture_status?: null | string;
    isrc: null | string;
    label: null | string;
    title: string;
  },
  archive: ArchiveAffinity,
  findingIsrcs: Map<string, string>,
  findingMatchKeys: Map<string, string>,

  artistIds: string[],
): { duplicateOf: null | string; priority: number } {
  const cleared = candidate.capture_status === DUPLICATE_CLEARED;
  const isrcKey = cleared ? null : normalizeIsrc(candidate.isrc);
  const isrcDup = isrcKey ? (findingIsrcs.get(isrcKey) ?? null) : null;

  const keyDup =
    cleared || isrcDup
      ? null
      : (findingMatchKeys.get(
          matchKey(parseArtistsJson(candidate.artists_json), candidate.title),
        ) ?? null);
  const duplicateOf = isrcDup ?? keyDup;
  const priority = duplicateOf
    ? DUPLICATE_CAPTURE_TIER
    : ladderTierForRow(
        { artistIds, artists: parseArtistsJson(candidate.artists_json), label: candidate.label },
        archive,

        cleared,
      ).priority;

  return { duplicateOf, priority };
}

async function readTrackArtistIds(trackIds: string[]): Promise<Map<string, string[]>> {
  const byTrack = new Map<string, string[]>();

  if (trackIds.length === 0) {
    return byTrack;
  }

  const db = await getDb();
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id, artist_id
          from track_artists
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });

  for (const row of typedRows<{ artist_id: string; track_id: string }>(result.rows)) {
    const list = byTrack.get(row.track_id);

    if (list) {
      list.push(row.artist_id);
    } else {
      byTrack.set(row.track_id, [row.artist_id]);
    }
  }

  return byTrack;
}

export const FINDING_QUALIFIED_ARTISTS_SQL = `select distinct ta.artist_id as artist_id
      from findings f
      cross join track_artists ta on ta.track_id = f.track_id`;

export const WEIGHTED_QUALIFIED_ARTISTS_SQL = `select ta.artist_id as artist_id
      from labels l
      join tracks t on t.label_id = l.id
      join track_artists ta on ta.track_id = t.track_id
      where l.seed_state = 'enabled'
      group by ta.artist_id
      having sum(case when ta.role = 'remixer' then 0.5 else 1.0 end) >= 3`;

export const QUALIFIED_ARTISTS_SQL = `select artist_id from (${FINDING_QUALIFIED_ARTISTS_SQL})
      union
      select artist_id from (${WEIGHTED_QUALIFIED_ARTISTS_SQL})`;

async function readArchiveAffinity(): Promise<ArchiveAffinity> {
  const db = await getDb();
  const [artistResult, labelResult, seedResult, qualifiedArtistIds] = await Promise.all([
    db.execute({
      args: [],
      sql: `select tracks.artists_json as artists_json
              from findings cross join tracks on tracks.track_id = findings.track_id`,
    }),
    db.execute({
      args: [],
      sql: `select distinct tracks.label as label
              from findings cross join tracks on tracks.track_id = findings.track_id
              where tracks.label is not null and trim(tracks.label) <> ''`,
    }),
    db.execute({
      args: [],

      sql: `select slug, seed_state from labels where seed_state in ('enabled', 'disabled')`,
    }),

    readQualifiedArtistIds(db, QUALIFIED_ARTISTS_SQL),
  ]);

  const findingArtists = new Set<string>();

  for (const row of typedRows<{ artists_json: string }>(artistResult.rows)) {
    for (const artist of parseArtistsJson(row.artists_json)) {
      findingArtists.add(artist.trim().toLowerCase());
    }
  }

  const findingLabels = new Set<string>();

  for (const row of typedRows<{ label: string }>(labelResult.rows)) {
    const slug = labelSlug(row.label);

    if (slug) {
      findingLabels.add(slug);
    }
  }

  const disabledLabels = new Set<string>();
  const seedLabels = new Set<string>();

  for (const row of typedRows<{ seed_state: string; slug: string }>(seedResult.rows)) {
    (row.seed_state === "disabled" ? disabledLabels : seedLabels).add(row.slug);
  }

  const qualifiedArtists = new Set<string>();

  for (const artistId of qualifiedArtistIds) {
    qualifiedArtists.add(artistId);
  }

  return { disabledLabels, findingArtists, findingLabels, qualifiedArtists, seedLabels };
}

async function readFindingIsrcs(): Promise<Map<string, string>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select findings.track_id as track_id, tracks.isrc as isrc
          from findings cross join tracks on tracks.track_id = findings.track_id
          where tracks.isrc is not null and trim(tracks.isrc) <> ''`,
  });

  const byIsrc = new Map<string, string>();

  for (const row of typedRows<{ isrc: string; track_id: string }>(result.rows)) {
    const key = normalizeIsrc(row.isrc);

    if (key) {
      byIsrc.set(key, row.track_id);
    }
  }

  return byIsrc;
}

type FindingIdentity = {
  byMatchKey: Map<string, string>;

  byTrack: Map<string, string>;
};

async function readFindingIdentity(): Promise<FindingIdentity> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select findings.track_id as track_id, tracks.title as title, tracks.artists_json as artists_json
          from findings cross join tracks on tracks.track_id = findings.track_id`,
  });

  const byMatchKey = new Map<string, string>();
  const byTrack = new Map<string, string>();

  for (const row of typedRows<{ artists_json: string; title: string; track_id: string }>(
    result.rows,
  )) {
    const key = matchKey(parseArtistsJson(row.artists_json), row.title);

    byTrack.set(row.track_id, key);

    const incumbent = byMatchKey.get(key);

    if (incumbent === undefined || row.track_id < incumbent) {
      byMatchKey.set(key, row.track_id);
    }
  }

  return { byMatchKey, byTrack };
}

type CatalogueIdentity = {
  byIsrc: Map<string, string>;
  byMatchKey: Map<string, string>;
};

async function readCatalogueIdentity(
  candidates: CatalogueCandidateIdentity[],
): Promise<CatalogueIdentity> {
  const db = await getDb();
  const byMatchKey = new Map<string, string>();
  const byIsrc = new Map<string, string>();

  const eligibleCandidates = candidates.filter(
    (candidate) => candidate.capture_status !== DUPLICATE_CLEARED,
  );
  const matchKeys = [
    ...new Set(
      eligibleCandidates.map((candidate) =>
        matchKey(parseArtistsJson(candidate.artists_json), candidate.title),
      ),
    ),
  ];
  const isrcKeys = [
    ...new Set(
      eligibleCandidates
        .map((candidate) => normalizeIsrc(candidate.isrc))
        .filter((key): key is string => key !== null),
    ),
  ];

  if (matchKeys.length > 0) {
    const result = await db.execute({
      args: [...matchKeys, WRONG_AUDIO_STATUS, DUPLICATE_CLEARED],
      sql: `select identity_key, track_id
            from (
              select duplicate_keys.match_key as identity_key,
                     duplicate_keys.track_id as track_id,
                     row_number() over (
                       partition by duplicate_keys.match_key
                       order by tracks.has_embedding desc,
                                duplicate_keys.track_id asc
                     ) as canonical_rank
              from track_duplicate_keys duplicate_keys
              join tracks on tracks.track_id = duplicate_keys.track_id
              where duplicate_keys.match_key in (${matchKeys.map(() => "?").join(", ")})
                and tracks.is_catalogue = 1
                and tracks.source_audio_key is not null
                and tracks.dismissed_at is null
                and (tracks.capture_status is null
                     or (tracks.capture_status <> ? and tracks.capture_status <> ?))
            )
            where canonical_rank = 1`,
    });

    for (const row of typedRows<{ identity_key: string; track_id: string }>(result.rows)) {
      byMatchKey.set(row.identity_key, row.track_id);
    }
  }

  if (isrcKeys.length > 0) {
    const result = await db.execute({
      args: [...isrcKeys, WRONG_AUDIO_STATUS, DUPLICATE_CLEARED],
      sql: `select identity_key, track_id
            from (
              select duplicate_keys.normalized_isrc as identity_key,
                     duplicate_keys.track_id as track_id,
                     row_number() over (
                       partition by duplicate_keys.normalized_isrc
                       order by tracks.has_embedding desc,
                                duplicate_keys.track_id asc
                     ) as canonical_rank
              from track_duplicate_keys duplicate_keys
              join tracks on tracks.track_id = duplicate_keys.track_id
              where duplicate_keys.normalized_isrc in (${isrcKeys.map(() => "?").join(", ")})
                and tracks.is_catalogue = 1
                and tracks.source_audio_key is not null
                and tracks.dismissed_at is null
                and (tracks.capture_status is null
                     or (tracks.capture_status <> ? and tracks.capture_status <> ?))
            )
            where canonical_rank = 1`,
    });

    for (const row of typedRows<{ identity_key: string; track_id: string }>(result.rows)) {
      byIsrc.set(row.identity_key, row.track_id);
    }
  }

  return { byIsrc, byMatchKey };
}

type CatalogueCandidateIdentity = {
  artists_json: string;
  capture_status?: null | string;
  has_vector: number;
  isrc: null | string;
  title: string;
  track_id: string;
};

function catalogueDuplicateOf(
  candidate: {
    artists_json: string;
    capture_status?: null | string;
    isrc: null | string;
    title: string;
    track_id: string;
  },
  identity: CatalogueIdentity,
): null | string {
  if (candidate.capture_status === DUPLICATE_CLEARED) {
    return null;
  }

  const key = matchKey(parseArtistsJson(candidate.artists_json), candidate.title);
  const byKey = identity.byMatchKey.get(key);

  if (byKey && byKey !== candidate.track_id) {
    return byKey;
  }

  const isrcKey = normalizeIsrc(candidate.isrc);
  const byIsrc = isrcKey ? identity.byIsrc.get(isrcKey) : undefined;

  return byIsrc && byIsrc !== candidate.track_id ? byIsrc : null;
}

async function readProjectedCatalogueRankBatch(
  db: Awaited<ReturnType<typeof getDb>>,
  limit: number,
): Promise<{ candidates: CandidateRow[]; hasMore: boolean }> {
  const selectedIds: string[] = [];
  let continuation: { sortKey: string; subjectId: string } | undefined;
  let hasMore = false;

  while (selectedIds.length < limit) {
    const pageLimit = Math.min(250, limit - selectedIds.length);
    const page = await readPromotedDueWorkPage(db, "catalogue-rank", {
      continuation,
      limit: pageLimit,
    });
    selectedIds.push(...page.subjectIds);
    hasMore = page.hasMore;

    const lastId = page.subjectIds.at(-1);
    if (lastId === undefined || page.subjectIds.length < pageLimit) {
      break;
    }
    continuation = {
      sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: lastId }]),
      subjectId: lastId,
    };
  }

  if (selectedIds.length === 0) {
    return { candidates: [], hasMore };
  }

  const candidateResult = await db.execute({
    args: selectedIds,
    sql: `select ct.track_id as track_id,
                 ct.title as title,
                 ct.artists_json as artists_json,
                 ct.label as label,
                 ct.isrc as isrc,
                 ct.capture_status as capture_status,
                 ct.source_audio_key as source_audio_key,
                 ct.source_audio_rejected as source_audio_rejected,
                 ct.has_embedding as has_vector,

                 ct.is_catalogue as is_catalogue,

                 ct.dismissed_at as dismissed_at
          from tracks ct
          where ct.track_id in (${selectedIds.map(() => "?").join(", ")})`,
  });
  const byId = new Map(
    typedRows<CandidateRow>(candidateResult.rows).map((row) => [row.track_id, row]),
  );

  return {
    candidates: selectedIds.flatMap((trackId) => {
      const row = byId.get(trackId);
      return row === undefined ? [] : [row];
    }),
    hasMore,
  };
}

async function emptyCatalogueRankSummary(options: {
  corpus: string;
  db: Awaited<ReturnType<typeof getDb>>;
  dueWorkCutoverEnabled: boolean;
  embeddedFindings: number;
  findings: number;
  limit: number;
  projectionHasMore: boolean;
}): Promise<RankCatalogueSummary> {
  if (!options.dueWorkCutoverEnabled) {
    await persistCatalogueCaches();
  }

  let remaining = 0;
  if (options.limit <= 0) {
    remaining = options.dueWorkCutoverEnabled
      ? await countDueWorkNow(options.db, "catalogue-rank")
      : await countStale(options.corpus);
  } else if (options.dueWorkCutoverEnabled && options.projectionHasMore) {
    remaining = RANK_MORE_REMAIN;
  }

  return {
    catalogueDuplicates: 0,
    corpus: options.corpus,
    embeddedFindings: options.embeddedFindings,
    findings: options.findings,
    prioritized: 0,
    quarantined: 0,
    remaining,
    scored: 0,
  };
}

async function readRankStateForCandidates(
  dueWorkCutoverEnabled: boolean,
  candidates: CandidateRow[],
): Promise<CatalogueRankState> {
  if (!dueWorkCutoverEnabled || candidates.length > 0) {
    return refreshCatalogueRankStateCache();
  }
  const state = parseCatalogueRankState(await getSetting(CATALOGUE_RANK_STATE_KEY));
  if (state === undefined) {
    throw new DueWorkMaintenancePendingError("catalogue-rank-state");
  }
  return state;
}

async function remainingCatalogueRankWork(options: {
  candidateCount: number;
  corpus: string;
  countRemaining: boolean;
  db: Awaited<ReturnType<typeof getDb>>;
  dueWorkCutoverEnabled: boolean;
  limit: number;
  projectionHasMore: boolean;
}): Promise<number> {
  if (options.countRemaining) {
    return options.dueWorkCutoverEnabled
      ? countDueWorkNow(options.db, "catalogue-rank")
      : countStale(options.corpus);
  }

  return options.dueWorkCutoverEnabled
    ? options.projectionHasMore
      ? RANK_MORE_REMAIN
      : 0
    : options.candidateCount >= options.limit
      ? RANK_MORE_REMAIN
      : 0;
}

function nearWrongAudioRows(
  vectored: CandidateRow[],
  winners: ReadonlyMap<string, WinnerRow>,
): CandidateRow[] {
  return vectored.filter((row) => {
    const winner = winners.get(row.track_id);
    return (
      row.capture_status !== QUARANTINE_CLEARED &&
      winner !== undefined &&
      1 - Number(winner.dist) >= WRONG_AUDIO_QUARANTINE
    );
  });
}

function preAudioTrackIdsFor(unvectored: CandidateRow[], nearWrongAudio: CandidateRow[]): string[] {
  return unvectored.length > 0 || nearWrongAudio.length > 0
    ? [...unvectored, ...nearWrongAudio].map((row) => row.track_id)
    : [];
}

function splitCandidateVectors(candidates: CandidateRow[]): {
  unvectored: CandidateRow[];
  vectored: CandidateRow[];
} {
  return {
    unvectored: candidates.filter((row) => Number(row.has_vector) !== 1),
    vectored: candidates.filter((row) => Number(row.has_vector) === 1),
  };
}

function wrongAudioWinner(
  candidate: CandidateRow,
  winner: WinnerRow | undefined,
  score: number | null,
): WinnerRow | undefined {
  return winner !== undefined &&
    score !== null &&
    score >= WRONG_AUDIO_QUARANTINE &&
    candidate.capture_status !== QUARANTINE_CLEARED
    ? winner
    : undefined;
}

async function projectedRankBatch(
  db: Awaited<ReturnType<typeof getDb>>,
  dueWorkCutoverEnabled: boolean,
  limit: number,
): Promise<Awaited<ReturnType<typeof readProjectedCatalogueRankBatch>>> {
  if (!dueWorkCutoverEnabled) {
    return { candidates: [], hasMore: false };
  }
  return readProjectedCatalogueRankBatch(db, Math.max(0, limit));
}

async function legacyRankCandidates(
  db: Awaited<ReturnType<typeof getDb>>,
  dueWorkCutoverEnabled: boolean,
  projectedCandidates: CandidateRow[],
  corpus: string,
  limit: number,
): Promise<CandidateRow[]> {
  if (dueWorkCutoverEnabled) {
    return projectedCandidates;
  }

  const candidateResult = await db.execute({
    args: [corpus, catalogueRankCorpusForTrack(corpus, false), Math.max(0, limit)],
    sql: `select ct.track_id as track_id,
               ct.title as title,
               ct.artists_json as artists_json,
               ct.label as label,
               ct.isrc as isrc,
               ct.capture_status as capture_status,
               ct.source_audio_key as source_audio_key,
               ct.source_audio_rejected as source_audio_rejected,
               ct.has_embedding as has_vector,

               ct.is_catalogue as is_catalogue,

               ct.dismissed_at as dismissed_at
        from tracks ct
        where ct.is_catalogue = 1
          and ct.dismissed_at is null
          and (ct.catalogue_rank_corpus is null
               or (ct.has_embedding = 1 and ct.catalogue_rank_corpus <> ?)
               or (ct.has_embedding = 0 and ct.catalogue_rank_corpus <> ?)
               or (ct.has_embedding = 1
                   and ct.capture_priority is not null
                   and ct.capture_priority >= 0))
        order by ct.track_id asc
        limit ?`,
  });
  return typedRows<CandidateRow>(candidateResult.rows);
}

async function nearestFindingWinners(
  db: Awaited<ReturnType<typeof getDb>>,
  vectored: CandidateRow[],
  embeddedFindings: number,
): Promise<Map<string, WinnerRow>> {
  const winners = new Map<string, WinnerRow>();
  if (vectored.length === 0 || embeddedFindings === 0) {
    return winners;
  }

  const ids = vectored.map((row) => row.track_id);
  const placeholders = ids.map(() => "?").join(", ");
  const rankedResult = await db.execute({
    args: ids,
    sql: `with finding_vec as materialized (
            select fe.track_id as fid, fe.embedding_blob as fvec
            from findings
            cross join track_embeddings fe on fe.track_id = findings.track_id
          ),
          candidate_vec as materialized (
            select ce.track_id as cid, ce.embedding_blob as cvec
            from track_embeddings ce
            where ce.track_id in (${placeholders})
          ),
          pair as (
            select candidate_vec.cid as cid,
                   finding_vec.fid as fid,
                   vector_distance_cos(candidate_vec.cvec, finding_vec.fvec) as dist
            from candidate_vec
            join finding_vec
          )
          select cid, fid, dist from (
            select cid, fid, dist,
                   row_number() over (partition by cid order by dist asc, fid asc) as rn
            from pair
          )
          where rn = 1`,
  });

  for (const row of typedRows<WinnerRow>(rankedResult.rows)) {
    winners.set(row.cid, row);
  }
  return winners;
}

async function readArchiveAffinityWhenNeeded(needsPreAudio: boolean) {
  return needsPreAudio ? readArchiveAffinity() : undefined;
}

async function readFindingIsrcsWhenNeeded(needsPreAudio: boolean) {
  return needsPreAudio ? readFindingIsrcs() : undefined;
}

function preAudioPlan(unvectored: CandidateRow[], nearWrongAudio: CandidateRow[]) {
  const trackIds = preAudioTrackIdsFor(unvectored, nearWrongAudio);
  return { needed: trackIds.length > 0, trackIds };
}

function nearestFindingScore(winner: WinnerRow | undefined): null | number {
  return winner ? 1 - Number(winner.dist) : null;
}

async function rankCatalogueBatch(
  limit: number,
  countRemaining: boolean,
): Promise<RankCatalogueSummary> {
  const db = await getDb();
  const dueWorkCutoverEnabled = await isDueWorkCutoverEnabled();

  const projectedBatch = await projectedRankBatch(db, dueWorkCutoverEnabled, limit);
  let candidates = projectedBatch.candidates;
  const projectionHasMore = projectedBatch.hasMore;

  const selectedAt = new Date().toISOString();

  const rankState = await readRankStateForCandidates(dueWorkCutoverEnabled, candidates);
  const { corpus, embeddedFindings, findings } = rankState;

  candidates = await legacyRankCandidates(db, dueWorkCutoverEnabled, candidates, corpus, limit);

  if (candidates.length === 0) {
    return emptyCatalogueRankSummary({
      corpus,
      db,
      dueWorkCutoverEnabled,
      embeddedFindings,
      findings,
      limit,
      projectionHasMore,
    });
  }

  const { unvectored, vectored } = splitCandidateVectors(candidates);
  const now = new Date().toISOString();
  const writes: InStatement[] = [];

  const projected: RankProjectionInputs[] = [];
  const rankableRepairs: InStatement[] = [];

  const winners = await nearestFindingWinners(db, vectored, embeddedFindings);

  const nearWrongAudio = nearWrongAudioRows(vectored, winners);
  const { needed: needsPreAudio, trackIds: preAudioTrackIds } = preAudioPlan(
    unvectored,
    nearWrongAudio,
  );

  const [artistIdsByTrack, archive, findingIsrcs, findingIdentity, catalogueIdentity] =
    await Promise.all([
      readTrackArtistIds(preAudioTrackIds),
      readArchiveAffinityWhenNeeded(needsPreAudio),
      readFindingIsrcsWhenNeeded(needsPreAudio),

      readFindingIdentity(),

      readCatalogueIdentity(candidates),
    ]);
  const findingMatchKeys = findingIdentity.byMatchKey;

  let quarantined = 0;

  let catalogueDuplicates = 0;

  for (const candidate of vectored) {
    const winner = winners.get(candidate.track_id);

    const score = nearestFindingScore(winner);

    const adjudicatedWinner = wrongAudioWinner(candidate, winner, score);
    if (adjudicatedWinner) {
      const winner = adjudicatedWinner;
      const rowKey = matchKey(parseArtistsJson(candidate.artists_json), candidate.title);
      const findingKey = findingIdentity.byTrack.get(winner.fid);
      const sameTitle = findingKey !== undefined && findingKey === rowKey;

      const forcedPastDuplicate = candidate.capture_status === DUPLICATE_CLEARED;

      if (sameTitle && !forcedPastDuplicate) {
        writes.push({
          args: [
            score,
            winner.fid,
            DUPLICATE_CAPTURE_TIER,
            winner.fid,
            corpus,
            now,
            candidate.track_id,
          ],
          sql: `update tracks
                set nearest_finding_score = ?,
                    nearest_finding_track_id = ?,
                    capture_priority = ?,
                    duplicate_of_track_id = ?,
                    catalogue_rank_corpus = ?,
                    catalogue_ranked_at = ?
                where track_id = ?`,
        });
        projected.push({
          capturePriority: DUPLICATE_CAPTURE_TIER,
          captureStatus: candidate.capture_status,
          duplicateOfTrackId: winner.fid,
          hasEmbedding: candidate.has_vector === 1,
          nearestFindingScore: score,
          observedDismissedAt: candidate.dismissed_at,
          observedIsCatalogue: candidate.is_catalogue === 1,
          trackId: candidate.track_id,
        });
        continue;
      }

      if (!sameTitle) {
        const preAudio = archive
          ? preAudioPriority(
              candidate,
              archive,
              findingIsrcs ?? new Map<string, string>(),
              findingMatchKeys,
              artistIdsByTrack.get(candidate.track_id) ?? [],
            )
          : { duplicateOf: null, priority: 0 };
        quarantined += 1;
        writes.push({
          args: [
            WRONG_AUDIO_STATUS,
            winner.fid,
            preAudio.priority,
            preAudio.duplicateOf,
            appendRejectedSha(
              candidate.source_audio_rejected,
              shaFromSourceAudioKey(candidate.source_audio_key),
              "quarantine",
              now,
            ),
            catalogueRankCorpusForTrack(corpus, false),
            now,
            candidate.track_id,
          ],
          sql: `update tracks
              set capture_status = ?,
                  ${CLEAR_EMBEDDING_SQL},
                  nearest_finding_score = null,
                  nearest_finding_track_id = ?,
                  capture_priority = ?,
                  duplicate_of_track_id = ?,
                  source_audio_rejected = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?
              where track_id = ?`,
        });
        projected.push({
          capturePriority: preAudio.priority,
          captureStatus: WRONG_AUDIO_STATUS,
          duplicateOfTrackId: preAudio.duplicateOf,
          hasEmbedding: false,
          nearestFindingScore: null,
          observedDismissedAt: candidate.dismissed_at,
          observedIsCatalogue: candidate.is_catalogue === 1,
          trackId: candidate.track_id,
        });

        writes.push(clearEmbeddingSatellite(candidate.track_id));
        rankableRepairs.push(repairRankableArtistsForTrackStatement(candidate.track_id));
        continue;
      }
    }

    const findingDuplicate =
      candidate.capture_status === DUPLICATE_CLEARED
        ? null
        : (findingMatchKeys.get(
            matchKey(parseArtistsJson(candidate.artists_json), candidate.title),
          ) ?? null);

    if (findingDuplicate) {
      writes.push({
        args: [
          score,
          winner?.fid ?? null,
          DUPLICATE_CAPTURE_TIER,
          findingDuplicate,
          corpus,
          now,
          candidate.track_id,
        ],
        sql: `update tracks
              set nearest_finding_score = ?,
                  nearest_finding_track_id = ?,
                  capture_priority = ?,
                  duplicate_of_track_id = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?
              where track_id = ?`,
      });
      projected.push({
        capturePriority: DUPLICATE_CAPTURE_TIER,
        captureStatus: candidate.capture_status,
        duplicateOfTrackId: findingDuplicate,
        hasEmbedding: candidate.has_vector === 1,
        nearestFindingScore: score,
        observedDismissedAt: candidate.dismissed_at,
        observedIsCatalogue: candidate.is_catalogue === 1,
        trackId: candidate.track_id,
      });
      continue;
    }

    const canonical = catalogueIdentity ? catalogueDuplicateOf(candidate, catalogueIdentity) : null;

    if (canonical) {
      catalogueDuplicates += 1;
      writes.push({
        args: [
          score,
          winner?.fid ?? null,
          DUPLICATE_CAPTURE_TIER,
          canonical,
          corpus,
          now,
          candidate.track_id,
        ],
        sql: `update tracks
              set nearest_finding_score = ?,
                  nearest_finding_track_id = ?,
                  capture_priority = ?,
                  duplicate_of_track_id = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?
              where track_id = ?`,
      });
      projected.push({
        capturePriority: DUPLICATE_CAPTURE_TIER,
        captureStatus: candidate.capture_status,
        duplicateOfTrackId: canonical,
        hasEmbedding: candidate.has_vector === 1,
        nearestFindingScore: score,
        observedDismissedAt: candidate.dismissed_at,
        observedIsCatalogue: candidate.is_catalogue === 1,
        trackId: candidate.track_id,
      });
      continue;
    }

    writes.push({
      args: [
        score,
        winner?.fid ?? null,
        corpus,
        now,

        candidate.track_id,
      ],
      sql: `update tracks
            set nearest_finding_score = ?,
                nearest_finding_track_id = ?,
                catalogue_rank_corpus = ?,
                catalogue_ranked_at = ?,
                capture_priority = null,
                duplicate_of_track_id = null
            where track_id = ?`,
    });
    projected.push({
      capturePriority: null,
      captureStatus: candidate.capture_status,
      duplicateOfTrackId: null,
      hasEmbedding: candidate.has_vector === 1,
      nearestFindingScore: score,
      observedDismissedAt: candidate.dismissed_at,
      observedIsCatalogue: candidate.is_catalogue === 1,
      trackId: candidate.track_id,
    });
  }

  if (unvectored.length > 0 && archive) {
    for (const candidate of unvectored) {
      const finding = preAudioPriority(
        candidate,
        archive,
        findingIsrcs ?? new Map<string, string>(),
        findingMatchKeys,
        artistIdsByTrack.get(candidate.track_id) ?? [],
      );

      const canonical =
        finding.duplicateOf ??
        (catalogueIdentity ? catalogueDuplicateOf(candidate, catalogueIdentity) : null);
      const duplicateOf = canonical;
      const priority = canonical ? DUPLICATE_CAPTURE_TIER : finding.priority;

      writes.push({
        args: [
          priority,
          duplicateOf,
          catalogueRankCorpusForTrack(corpus, false),
          now,
          candidate.track_id,
        ],
        sql: `update tracks
              set capture_priority = ?,
                  duplicate_of_track_id = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?,
                  nearest_finding_score = null,
                  nearest_finding_track_id = null
              where track_id = ?`,
      });
      projected.push({
        capturePriority: priority,
        captureStatus: candidate.capture_status,
        duplicateOfTrackId: duplicateOf,
        hasEmbedding: false,
        nearestFindingScore: null,
        observedDismissedAt: candidate.dismissed_at,
        observedIsCatalogue: candidate.is_catalogue === 1,
        trackId: candidate.track_id,
      });
    }
  }

  const movedIds = candidates.map((candidate) => candidate.track_id);
  const before = await readBatchRowBuckets(movedIds);

  await db.batch(
    [
      ...rankMaintenanceStatements(projected, new Date().toISOString()),
      ...writes,
      ...rankSettledStatements(movedIds, selectedAt),
      ...rankableRepairs,
    ],
    "write",
  );

  await applyCatalogueSummaryBatchDelta(before, await readBatchRowBuckets(movedIds));

  await refreshArchiveAffinityCache(archive);

  const remaining = await remainingCatalogueRankWork({
    candidateCount: candidates.length,
    corpus,
    countRemaining,
    db,
    dueWorkCutoverEnabled,
    limit,
    projectionHasMore,
  });

  return {
    catalogueDuplicates,
    corpus,
    embeddedFindings,
    findings,
    prioritized: unvectored.length,
    quarantined,
    remaining,

    scored: vectored.length - quarantined,
  };
}

export function rankCatalogue(
  limit = RANK_BATCH_SIZE,
  countRemaining = false,
): Promise<RankCatalogueSummary> {
  return rankCatalogueBatch(limit, countRemaining);
}

async function countStale(corpus: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [corpus, catalogueRankCorpusForTrack(corpus, false)],
    sql: `select count(*) as n
          from tracks ct
          where ct.is_catalogue = 1
            and ct.dismissed_at is null
            and (ct.catalogue_rank_corpus is null
                 or (ct.has_embedding = 1 and ct.catalogue_rank_corpus <> ?)
                 or (ct.has_embedding = 0 and ct.catalogue_rank_corpus <> ?)
                 or (ct.has_embedding = 1
                     and ct.capture_priority is not null
                     and ct.capture_priority >= 0))`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

export type CatalogueLens = "capture" | "dismissed" | "ear" | "failed" | "quarantine" | "unmatched";

export type CatalogueMatch = {
  artists: string[];
  logId: string | null;
  title: string;
  trackId: string;
};

export type CatalogueTrackItem = {
  albumImageUrl: string | null;

  appleMusicUrl: string | null;
  artists: string[];
  bpm: number | null;
  capturePriority: number | null;
  captureReason: CapturePriorityReason | null;

  captureStatus: string | null;

  captureVerification: string | null;

  dismissedAt: string | null;

  duplicateOf: CatalogueMatch | null;

  hasCapturedAudio: boolean;

  hasPreview: boolean;
  isrc: string | null;
  key: string | null;
  label: string | null;

  nearestFinding: CatalogueMatch | null;

  nearestFindingScore: number | null;
  rankedAt: string | null;
  releaseDate: string | null;

  sourceAudioAttemptedAt: string | null;
  spotifyUrl: string | null;
  title: string;
  trackId: string;
};

export type CatalogueSummary = {
  awaitingCapture: number;

  awaitingRank: number;

  computedAt: string | null;

  dismissed: number;

  quarantined: number;

  ranked: number;

  total: number;
};

const CATALOGUE_SUMMARY_KEY = "catalogue_summary_cache";

const CATALOGUE_AFFINITY_KEY = "catalogue_affinity_cache";

type CatalogueCounts = Omit<CatalogueSummary, "computedAt">;

export type SummaryBucket = keyof CatalogueCounts;

const SUMMARY_BUCKETS: readonly SummaryBucket[] = [
  "awaitingCapture",
  "awaitingRank",
  "dismissed",
  "quarantined",
  "ranked",
  "total",
];

export async function computeCatalogueCounts(): Promise<CatalogueCounts> {
  const db = await getDb();
  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS, WRONG_AUDIO_STATUS],
    sql: `select
            sum(case when ct.dismissed_at is null then 1 else 0 end) as total,
            sum(case when ct.dismissed_at is null
                      and ct.nearest_finding_score is not null
                      and ct.duplicate_of_track_id is null
                      and ct.duration_ms < ${LONG_FORM_MS} then 1 else 0 end) as ranked,
            sum(case when ct.dismissed_at is null
                      and ct.nearest_finding_score is null
                      and ct.capture_priority is not null
                      and ct.capture_status <> ?
                      and ct.duration_ms >= ${MIN_TRACK_MS}
                      and ct.duration_ms < ${LONG_FORM_MS} then 1 else 0 end) as awaiting_capture,
            sum(case when ct.dismissed_at is null
                      and ct.capture_status = ? then 1 else 0 end) as quarantined,
            sum(case when ct.dismissed_at is null
                      and ct.catalogue_rank_corpus is null then 1 else 0 end) as awaiting_rank,
            sum(case when ct.dismissed_at is not null then 1 else 0 end) as dismissed
          from tracks ct
          where ct.is_catalogue = 1`,
  });
  const row = typedRows<{
    awaiting_capture: number | null;
    awaiting_rank: number | null;
    dismissed: number | null;
    quarantined: number | null;
    ranked: number | null;
    total: number | null;
  }>(result.rows)[0];

  return {
    awaitingCapture: Number(row?.awaiting_capture ?? 0),
    awaitingRank: Number(row?.awaiting_rank ?? 0),
    dismissed: Number(row?.dismissed ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    ranked: Number(row?.ranked ?? 0),
    total: Number(row?.total ?? 0),
  };
}

export async function refreshCatalogueSummary(): Promise<CatalogueSummary> {
  const counts = await computeCatalogueCounts();
  const summary: CatalogueSummary = { ...counts, computedAt: new Date().toISOString() };

  await setSetting(CATALOGUE_SUMMARY_KEY, JSON.stringify(summary));

  return summary;
}

export type BucketRow = {
  capturePriority: null | number;
  captureStatus: string;
  catalogueRankCorpus: null | string;
  dismissedAt: null | string;
  duplicateOfTrackId: null | string;
  durationMs: null | number;
  nearestFindingScore: null | number;
};

export function bucketsForRow(row: BucketRow): Set<SummaryBucket> {
  const buckets = new Set<SummaryBucket>();
  const live = row.dismissedAt === null;

  if (!live) {
    buckets.add("dismissed");

    return buckets;
  }

  buckets.add("total");

  const withinLongForm = row.durationMs !== null && row.durationMs < LONG_FORM_MS;

  if (row.nearestFindingScore !== null && row.duplicateOfTrackId === null && withinLongForm) {
    buckets.add("ranked");
  }

  if (
    row.nearestFindingScore === null &&
    row.capturePriority !== null &&
    row.captureStatus !== WRONG_AUDIO_STATUS &&
    row.durationMs !== null &&
    row.durationMs >= MIN_TRACK_MS &&
    withinLongForm
  ) {
    buckets.add("awaitingCapture");
  }

  if (row.captureStatus === WRONG_AUDIO_STATUS) {
    buckets.add("quarantined");
  }

  if (row.catalogueRankCorpus === null) {
    buckets.add("awaitingRank");
  }

  return buckets;
}

export async function readRowBuckets(trackId: string): Promise<Set<SummaryBucket>> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select ct.capture_priority, ct.capture_status, ct.catalogue_rank_corpus, ct.dismissed_at,
                 ct.duplicate_of_track_id, ct.duration_ms, ct.nearest_finding_score
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where ct.track_id = ? and cf.track_id is null
          limit 1`,
  });
  const row = typedRow<{
    capture_priority: null | number;

    capture_status: null | string;
    catalogue_rank_corpus: null | string;
    dismissed_at: null | string;
    duplicate_of_track_id: null | string;
    duration_ms: null | number;
    nearest_finding_score: null | number;
  }>(result.rows);

  if (!row) {
    return new Set<SummaryBucket>();
  }

  return bucketsForRow({
    capturePriority: row.capture_priority,
    captureStatus: row.capture_status ?? "pending",
    catalogueRankCorpus: row.catalogue_rank_corpus,
    dismissedAt: row.dismissed_at,
    duplicateOfTrackId: row.duplicate_of_track_id,
    durationMs: row.duration_ms,
    nearestFindingScore: row.nearest_finding_score,
  });
}

async function readBatchRowBuckets(trackIds: string[]): Promise<Map<string, Set<SummaryBucket>>> {
  const byTrack = new Map<string, Set<SummaryBucket>>();

  if (trackIds.length === 0) {
    return byTrack;
  }

  const db = await getDb();
  const result = await db.execute({
    args: trackIds,
    sql: `select ct.track_id, ct.capture_priority, ct.capture_status, ct.catalogue_rank_corpus,
                 ct.dismissed_at, ct.duplicate_of_track_id, ct.duration_ms, ct.nearest_finding_score
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where ct.track_id in (${trackIds.map(() => "?").join(", ")}) and cf.track_id is null`,
  });

  for (const row of typedRows<{
    capture_priority: null | number;

    capture_status: null | string;
    catalogue_rank_corpus: null | string;
    dismissed_at: null | string;
    duplicate_of_track_id: null | string;
    duration_ms: null | number;
    nearest_finding_score: null | number;
    track_id: string;
  }>(result.rows)) {
    byTrack.set(
      row.track_id,
      bucketsForRow({
        capturePriority: row.capture_priority,
        captureStatus: row.capture_status ?? "pending",
        catalogueRankCorpus: row.catalogue_rank_corpus,
        dismissedAt: row.dismissed_at,
        duplicateOfTrackId: row.duplicate_of_track_id,
        durationMs: row.duration_ms,
        nearestFindingScore: row.nearest_finding_score,
      }),
    );
  }

  return byTrack;
}

async function applyCatalogueSummaryDelta(
  before: Set<SummaryBucket>,
  after: Set<SummaryBucket>,
): Promise<void> {
  const cached = await getSetting(CATALOGUE_SUMMARY_KEY);
  const parsed = cached ? parseSummaryCache(cached) : null;

  if (!parsed) {
    return;
  }

  const next: CatalogueSummary = { ...parsed, computedAt: new Date().toISOString() };

  for (const bucket of SUMMARY_BUCKETS) {
    const delta = (after.has(bucket) ? 1 : 0) - (before.has(bucket) ? 1 : 0);

    if (delta !== 0) {
      next[bucket] = Math.max(0, next[bucket] + delta);
    }
  }

  await setSetting(CATALOGUE_SUMMARY_KEY, JSON.stringify(next));
}

async function applyCatalogueSummaryBatchDelta(
  before: Map<string, Set<SummaryBucket>>,
  after: Map<string, Set<SummaryBucket>>,
): Promise<void> {
  const cached = await getSetting(CATALOGUE_SUMMARY_KEY);
  const parsed = cached ? parseSummaryCache(cached) : null;

  if (!parsed) {
    return;
  }

  const next: CatalogueSummary = { ...parsed, computedAt: new Date().toISOString() };
  const ids = new Set<string>([...before.keys(), ...after.keys()]);

  for (const bucket of SUMMARY_BUCKETS) {
    let delta = 0;

    for (const id of ids) {
      delta += (after.get(id)?.has(bucket) ? 1 : 0) - (before.get(id)?.has(bucket) ? 1 : 0);
    }

    if (delta !== 0) {
      next[bucket] = Math.max(0, next[bucket] + delta);
    }
  }

  await setSetting(CATALOGUE_SUMMARY_KEY, JSON.stringify(next));
}

async function withSummaryDelta(trackId: string, write: () => Promise<boolean>): Promise<boolean> {
  const before = await readRowBuckets(trackId);
  const changed = await write();

  if (changed) {
    const after = await readRowBuckets(trackId);

    await applyCatalogueSummaryDelta(before, after);
  }

  return changed;
}

function parseSummaryCache(value: string): CatalogueSummary | null {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;

  for (const field of [
    "awaitingCapture",
    "awaitingRank",
    "dismissed",
    "quarantined",
    "ranked",
    "total",
  ] as const) {
    if (typeof record[field] !== "number") {
      return null;
    }
  }

  return {
    awaitingCapture: Number(record.awaitingCapture),
    awaitingRank: Number(record.awaitingRank),
    computedAt: typeof record.computedAt === "string" ? record.computedAt : null,
    dismissed: Number(record.dismissed),
    quarantined: Number(record.quarantined),
    ranked: Number(record.ranked),
    total: Number(record.total),
  };
}

export async function getCatalogueSummary(): Promise<CatalogueSummary> {
  const cached = await getSetting(CATALOGUE_SUMMARY_KEY);

  if (cached) {
    const parsed = parseSummaryCache(cached);

    if (parsed) {
      return parsed;
    }
  }

  return refreshCatalogueSummary();
}

type CachedAffinity = {
  disabledLabels: string[];
  findingArtists: string[];
  findingLabels: string[];
  qualifiedArtists: string[];
  seedLabels: string[];
};

async function refreshArchiveAffinityCache(affinity?: ArchiveAffinity): Promise<void> {
  const resolved = affinity ?? (await readArchiveAffinity());
  const cached: CachedAffinity = {
    disabledLabels: [...resolved.disabledLabels],
    findingArtists: [...resolved.findingArtists],
    findingLabels: [...resolved.findingLabels],
    qualifiedArtists: [...resolved.qualifiedArtists],
    seedLabels: [...resolved.seedLabels],
  };

  await setSetting(CATALOGUE_AFFINITY_KEY, JSON.stringify(cached));
}

function toStringSet(value: unknown): null | Set<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }

  return new Set(value as string[]);
}

function parseAffinityCache(value: string): ArchiveAffinity | null {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const disabledLabels = toStringSet(record.disabledLabels);
  const findingArtists = toStringSet(record.findingArtists);
  const findingLabels = toStringSet(record.findingLabels);
  const qualifiedArtists = toStringSet(record.qualifiedArtists);
  const seedLabels = toStringSet(record.seedLabels);

  if (!disabledLabels || !findingArtists || !findingLabels || !qualifiedArtists || !seedLabels) {
    return null;
  }

  return { disabledLabels, findingArtists, findingLabels, qualifiedArtists, seedLabels };
}

async function readCaptureLensAffinity(): Promise<ArchiveAffinity> {
  const cached = await getSetting(CATALOGUE_AFFINITY_KEY);

  if (cached) {
    const parsed = parseAffinityCache(cached);

    if (parsed) {
      return parsed;
    }
  }

  return readArchiveAffinity();
}

async function persistCatalogueCaches(): Promise<void> {
  await Promise.all([refreshCatalogueSummary(), refreshArchiveAffinityCache()]);
}

type CatalogueRow = {
  album_image_url: string | null;
  apple_music_url: string | null;
  artists_json: string;
  bpm: number | null;
  capture_priority: number | null;
  capture_status: string | null;
  capture_verification: string | null;
  catalogue_ranked_at: string | null;
  dismissed_at: string | null;
  duplicate_of_track_id: string | null;
  has_captured_audio: number;
  isrc: string | null;
  key: string | null;
  label: string | null;
  nearest_finding_score: number | null;
  nearest_finding_track_id: string | null;
  preview_url: string | null;
  release_date: string | null;
  source_audio_attempted_at: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type MatchRow = {
  artists_json: string;
  log_id: string | null;
  title: string;
  track_id: string;
};

const CATALOGUE_SELECT = `ct.track_id, ct.title, ct.artists_json, ct.album_image_url, ct.spotify_url,
  ct.apple_music_url, ct.isrc, ct.preview_url, ct.bpm, ct.key, ct.label, ct.release_date,
  ct.nearest_finding_score, ct.nearest_finding_track_id, ct.capture_priority, ct.capture_status,
  ct.capture_verification, ct.catalogue_ranked_at, ct.duplicate_of_track_id, ct.dismissed_at,
  ct.source_audio_attempted_at, (ct.source_audio_key is not null) as has_captured_audio`;

export async function listCatalogueTracks(
  lens: CatalogueLens,
  limit = 50,
): Promise<CatalogueTrackItem[]> {
  const page = Math.min(Math.max(1, limit), 200);

  const fetchLimit = lens === "ear" ? Math.min(page * 3 + 25, 500) : page;
  const db = await getDb();

  const query =
    lens === "ear"
      ? {
          args: [fetchLimit],

          sql: `select ${CATALOGUE_SELECT}
                from tracks ct
                where ct.is_catalogue = 1
                  and ct.dismissed_at is null
                  and ct.nearest_finding_score is not null
                  and ct.duplicate_of_track_id is null
                  and ct.duration_ms < ${LONG_FORM_MS}
                order by ct.nearest_finding_score desc, ct.track_id desc
                limit ?`,
        }
      : lens === "quarantine"
        ? {
            args: [WRONG_AUDIO_STATUS, page],
            sql: `select ${CATALOGUE_SELECT}
                  from tracks ct
                  where ct.is_catalogue = 1 and ct.dismissed_at is null and ct.capture_status = ?
                  order by ct.catalogue_ranked_at desc, ct.track_id asc
                  limit ?`,
          }
        : lens === "unmatched" || lens === "failed"
          ? {
              args: [lens, page],
              sql: `select ${CATALOGUE_SELECT}
                    from tracks ct
                    where ct.is_catalogue = 1 and ct.dismissed_at is null and ct.capture_status = ?
                    order by ct.source_audio_attempted_at desc, ct.track_id asc
                    limit ?`,
            }
          : lens === "dismissed"
            ? {
                args: [page],
                sql: `select ${CATALOGUE_SELECT}
                    from tracks ct
                    where ct.is_catalogue = 1 and ct.dismissed_at is not null
                    order by ct.dismissed_at desc, ct.track_id asc
                    limit ?`,
              }
            : {
                args: [WRONG_AUDIO_STATUS, page],
                sql: `select ${CATALOGUE_SELECT}
                    from tracks ct
                    where ct.is_catalogue = 1
                      and ct.dismissed_at is null
                      and ct.nearest_finding_score is null
                      and ct.capture_priority is not null
                      and ct.capture_status <> ?
                      and ct.duration_ms >= ${MIN_TRACK_MS}
                      and ct.duration_ms < ${LONG_FORM_MS}
                    order by ct.capture_priority desc, ct.track_id desc
                    limit ?`,
              };
  const result = await db.execute(query);
  const rows = typedRows<CatalogueRow>(result.rows);

  if (rows.length === 0) {
    return [];
  }

  const matches = await hydrateMatches(
    rows.map((row) =>
      lens === "capture" ? row.duplicate_of_track_id : row.nearest_finding_track_id,
    ),
  );

  const archive = lens === "capture" ? await readCaptureLensAffinity() : undefined;

  const artistIdsByTrack =
    lens === "capture" ? await readTrackArtistIds(rows.map((row) => row.track_id)) : undefined;

  const items = rows.map((row) => {
    const artists = parseArtistsJson(row.artists_json);
    const nearestFinding = row.nearest_finding_track_id
      ? (matches.get(row.nearest_finding_track_id) ?? null)
      : null;

    const duplicateOf =
      lens === "ear"
        ? typeof row.nearest_finding_score === "number" &&
          row.nearest_finding_score >= DUPLICATE_SIMILARITY
          ? nearestFinding
          : null
        : row.duplicate_of_track_id
          ? (matches.get(row.duplicate_of_track_id) ?? null)
          : null;

    return {
      albumImageUrl: row.album_image_url,
      appleMusicUrl: row.apple_music_url,
      artists,
      bpm: row.bpm,
      capturePriority: row.capture_priority,
      captureReason: archive
        ? ladderTierForRow(
            { artistIds: artistIdsByTrack?.get(row.track_id) ?? [], artists, label: row.label },
            archive,
            row.capture_status === DUPLICATE_CLEARED,
          ).reason
        : null,
      captureStatus: row.capture_status,
      captureVerification: row.capture_verification,
      dismissedAt: row.dismissed_at,
      duplicateOf,

      hasCapturedAudio: Number(row.has_captured_audio) === 1,

      hasPreview: Boolean(row.preview_url) || Boolean(row.isrc && row.isrc.trim()),
      isrc: row.isrc,
      key: row.key,
      label: row.label,
      nearestFinding,
      nearestFindingScore: row.nearest_finding_score,
      rankedAt: row.catalogue_ranked_at,
      releaseDate: row.release_date,
      sourceAudioAttemptedAt: row.source_audio_attempted_at,
      spotifyUrl: row.spotify_url,
      title: row.title,
      trackId: row.track_id,
    };
  });

  if (lens === "ear") {
    return diversifyEarPage(
      items.filter((item) => item.duplicateOf === null),
      page,
    );
  }

  return items;
}

export type DiversitySignals = {
  artist: null | string;
  key: null | string;
  score: number;
  year: null | string;
};

export function diversifyRanked<T>(
  pool: T[],
  page: number,
  signalsOf: (item: T) => DiversitySignals,
): T[] {
  const picked: T[] = [];
  const artistSeen = new Map<string, number>();
  const yearSeen = new Map<string, number>();
  const keySeen = new Map<string, number>();
  const remaining = [...pool];

  while (picked.length < page && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (const [index, item] of remaining.entries()) {
      const { artist, key, score, year } = signalsOf(item);
      const decayed =
        score *
        EAR_DIVERSITY_DECAY.artist ** (artist ? (artistSeen.get(artist) ?? 0) : 0) *
        EAR_DIVERSITY_DECAY.year ** (year ? (yearSeen.get(year) ?? 0) : 0) *
        EAR_DIVERSITY_DECAY.key ** (key ? (keySeen.get(key) ?? 0) : 0);

      if (decayed > bestScore) {
        bestScore = decayed;
        bestIndex = index;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);

    if (chosen === undefined) {
      break;
    }

    const { artist, key, year } = signalsOf(chosen);

    if (artist) {
      artistSeen.set(artist, (artistSeen.get(artist) ?? 0) + 1);
    }

    if (year) {
      yearSeen.set(year, (yearSeen.get(year) ?? 0) + 1);
    }

    if (key) {
      keySeen.set(key, (keySeen.get(key) ?? 0) + 1);
    }

    picked.push(chosen);
  }

  return picked;
}

function diversifyEarPage(pool: CatalogueTrackItem[], page: number): CatalogueTrackItem[] {
  return diversifyRanked(pool, page, (item) => ({
    artist: item.artists[0] ? item.artists[0].trim().toLowerCase() : null,
    key: item.key ? item.key.trim().toLowerCase() : null,
    score: item.nearestFindingScore ?? 0,
    year: item.releaseDate ? item.releaseDate.slice(0, 4) : null,
  }));
}

async function hydrateMatches(findingIds: (string | null)[]): Promise<Map<string, CatalogueMatch>> {
  const ids = [...new Set(findingIds.filter((id): id is string => typeof id === "string"))];

  if (ids.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const result = await db.execute({
    args: ids,
    sql: `select tracks.track_id, tracks.title, tracks.artists_json, findings.log_id
          from findings
          join tracks on tracks.track_id = findings.track_id
          where tracks.track_id in (${ids.map(() => "?").join(", ")})`,
  });

  return new Map(
    typedRows<MatchRow>(result.rows).map((row) => [
      row.track_id,
      {
        artists: parseArtistsJson(row.artists_json),
        logId: row.log_id,
        title: row.title,
        trackId: row.track_id,
      },
    ]),
  );
}

export async function clearWrongAudio(trackId: string): Promise<boolean> {
  return withSummaryDelta(trackId, async () => {
    const db = await getDb();
    const [result] = await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [QUARANTINE_CLEARED, trackId, WRONG_AUDIO_STATUS],
          sql: `update tracks
              set capture_status = ?
              where track_id = ?
                and capture_status = ?
                and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
        },
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { onlyIfLastSourceStatementChanged: true, producer: "catalogue-clear-wrong-audio" },
    );

    return (result?.rowsAffected ?? 0) > 0;
  });
}

export async function requeueUnmatchedCaptures(): Promise<{
  requeued: number;
  skippedVetoed: number;
}> {
  const db = await getDb();
  const vetoed = await db.execute({
    sql: `select count(*) as vetoed
          from tracks
          where capture_status = 'unmatched'
            and is_catalogue = 1
            and (duration_ms is null
                 or duration_ms < ${MIN_TRACK_MS}
                 or duration_ms >= ${LONG_FORM_MS})`,
  });
  const source = {
    sql: `select track_id as subject_id from tracks
          where capture_status = 'unmatched'
            and is_catalogue = 1
            and duration_ms >= ${MIN_TRACK_MS}
            and duration_ms < ${LONG_FORM_MS}`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", source, {
        producer: "catalogue-requeue-unmatched",
      }),
      {
        sql: `update tracks
          set capture_status = 'pending',
              source_audio_failures = 0
          where capture_status = 'unmatched'
            and is_catalogue = 1
            and duration_ms >= ${MIN_TRACK_MS}
            and duration_ms < ${LONG_FORM_MS}`,
      },
    ],
    "write",
  );
  const result = results.at(-1);

  return {
    requeued: result?.rowsAffected ?? 0,
    skippedVetoed: Number(typedRows<{ vetoed: number | null }>(vetoed.rows)[0]?.vetoed ?? 0),
  };
}

export async function forceCapture(trackId: string): Promise<boolean> {
  return withSummaryDelta(trackId, async () => {
    const db = await getDb();
    const [result] = await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [DUPLICATE_CLEARED, trackId],
          sql: `update tracks
              set capture_status = ?,
                  duplicate_of_track_id = null,
                  capture_priority = null,
                  catalogue_rank_corpus = null
              where track_id = ?
                and duplicate_of_track_id is not null
                and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
        },
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { onlyIfLastSourceStatementChanged: true, producer: "catalogue-force-capture" },
    );

    return (result?.rowsAffected ?? 0) > 0;
  });
}

export async function flagWrongAudio(trackId: string): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();

  const rowResult = await db.execute({
    args: [trackId],
    sql: `select source_audio_key, source_audio_rejected
          from tracks
          where track_id = ?
            and source_audio_key is not null
            and capture_status <> 'wrong-audio'
            and exists (select 1 from findings where findings.track_id = tracks.track_id)
          limit 1`,
  });
  const row = typedRow<{ source_audio_key: null | string; source_audio_rejected: null | string }>(
    rowResult.rows,
  );

  if (!row) {
    return false;
  }

  const rejected = appendRejectedSha(
    row.source_audio_rejected,
    shaFromSourceAudioKey(row.source_audio_key),
    "flag-wrong-audio",
    now,
  );

  const [result] = await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [WRONG_AUDIO_STATUS, rejected, trackId],
        sql: `update tracks
          set capture_status = ?,
              ${CLEAR_EMBEDDING_SQL},
              analyzed_from = null,
              capture_verification = null,
              capture_source_pin = null,
              capture_source_pin_allow_duration = 0,
              youtube_video_id = case when youtube_verified_by = 'operator' then null else youtube_video_id end,
              youtube_video_official = case when youtube_verified_by = 'operator' then null else youtube_video_official end,
              youtube_verified_at = case when youtube_verified_by = 'operator' then null else youtube_verified_at end,
              source_verification = case when source_verification = 'operator' then null else source_verification end,
              youtube_verified_by = case when youtube_verified_by = 'operator' then null else youtube_verified_by end,
              source_audio_rejected = ?
          where track_id = ?
            and source_audio_key is not null
            and capture_status <> 'wrong-audio'
            and exists (select 1 from findings where findings.track_id = tracks.track_id)`,
      },
      clearEmbeddingSatellite(trackId),
    ],
    [
      { subjectId: trackId, subjectType: "track" },
      ...dueWorkCatalogueRankRepairSubjects("catalogue-flag-wrong-audio"),
    ],
    {
      afterMaintenanceStatements: [repairRankableArtistsForTrackStatement(trackId)],
      producer: "catalogue-flag-wrong-audio",
    },
  );

  return (result?.rowsAffected ?? 0) > 0;
}

export async function setTrackDismissed(trackId: string, dismissed: boolean): Promise<boolean> {
  return withSummaryDelta(trackId, async () => {
    const db = await getDb();
    const [result] = await batchDueWorkSourceMutation(
      db,
      [
        dismissed
          ? {
              args: [new Date().toISOString(), trackId],
              sql: `update tracks
              set dismissed_at = ?
              where track_id = ?
                and dismissed_at is null
                and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
            }
          : {
              args: [trackId],
              sql: `update tracks
              set dismissed_at = null
              where track_id = ?
                and dismissed_at is not null
                and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
            },
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { onlyIfLastSourceStatementChanged: true, producer: "catalogue-dismiss-track" },
    );

    return (result?.rowsAffected ?? 0) > 0;
  });
}

export type CaptureVerifyItem = {
  artists: string[];
  certified: boolean;

  durationMs: number;
  isrc: null | string;

  logId: null | string;
  sourceAudioKey: string;
  title: string;
  trackId: string;
};

export type CaptureVerifyVerdict = "match" | "mismatch" | "no-preview";

export type CaptureVerifyAction =
  | "flagged-finding"
  | "not-captured"
  | "operator-verified"
  | "preview-match"
  | "quarantined-catalogue"
  | "unverified";

export const OPERATOR_VERIFIED = "operator-verified";

type VerifyRow = {
  artists_json: string;
  capture_status: null | string;
  capture_verification: null | string;
  certified: number;
  isrc: null | string;
  label: null | string;
  source_audio_key: null | string;
  source_audio_rejected: null | string;
  title: string;
};

export async function listUnverifiedCaptures(limit = 50): Promise<CaptureVerifyItem[]> {
  const page = Math.min(Math.max(1, Math.trunc(limit)), 200);
  const db = await getDb();
  const dueWorkCutoverEnabled = await isDueWorkCutoverEnabled();
  let rows: Array<{
    artists_json: string;
    certified: number;
    duration_ms: null | number;
    isrc: null | string;
    log_id: null | string;
    source_audio_key: string;
    title: string;
    track_id: string;
  }>;

  if (dueWorkCutoverEnabled) {
    const selected = await readPromotedDueWorkPage(db, "capture-verification", { limit: page });

    if (selected.subjectIds.length === 0) {
      rows = [];
    } else {
      const result = await db.execute({
        args: selected.subjectIds,
        sql: `select ct.track_id as track_id, ct.title as title, ct.artists_json as artists_json,
                     ct.isrc as isrc, ct.duration_ms as duration_ms,
                     ct.source_audio_key as source_audio_key, f.log_id as log_id,
                     (f.track_id is not null) as certified
              from tracks ct
              left join findings f on f.track_id = ct.track_id
              where ct.track_id in (${selected.subjectIds.map(() => "?").join(", ")})`,
      });
      const byId = new Map(
        typedRows<(typeof rows)[number]>(result.rows).map((row) => [row.track_id, row]),
      );
      rows = selected.subjectIds.flatMap((trackId) => {
        const row = byId.get(trackId);
        return row === undefined ? [] : [row];
      });
    }
  } else {
    const result = await db.execute({
      args: [WRONG_AUDIO_STATUS, page],
      sql: `select ct.track_id as track_id, ct.title as title, ct.artists_json as artists_json,
                 ct.isrc as isrc, ct.duration_ms as duration_ms, ct.source_audio_key as source_audio_key,
                 f.log_id as log_id, (f.track_id is not null) as certified
          from tracks ct
          left join findings f on f.track_id = ct.track_id
          where ct.source_audio_key is not null
            and ct.capture_verification is null
            and (ct.capture_status is null or ct.capture_status <> ?)
          order by ct.track_id asc
          limit ?`,
    });
    rows = typedRows<(typeof rows)[number]>(result.rows);
  }

  return rows.map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    certified: Number(row.certified) === 1,
    durationMs: Number(row.duration_ms) || 0,
    isrc: row.isrc,
    logId: row.log_id,
    sourceAudioKey: row.source_audio_key,
    title: row.title,
    trackId: row.track_id,
  }));
}

export const COUNT_UNVERIFIED_CAPTURES_SQL = `select count(*) as queued
          from tracks ct
          where ct.source_audio_key is not null
            and ct.capture_verification is null
            and (ct.capture_status is null or ct.capture_status <> ?)`;

export async function countUnverifiedCaptures(): Promise<number> {
  const db = await getDb();
  if (await isDueWorkCutoverEnabled()) {
    const { repairDueWorkBeforeRead } = await import("./due-work-source-repair");
    await repairDueWorkBeforeRead(db, "capture-verification");
    return countDueWorkNow(db, "capture-verification");
  }

  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS],
    sql: COUNT_UNVERIFIED_CAPTURES_SQL,
  });
  const row = typedRows<{ queued: bigint | number }>(result.rows)[0];

  return Number(row?.queued ?? 0);
}

export async function verifyCapture(
  trackId: string,
  verdict: CaptureVerifyVerdict,
): Promise<CaptureVerifyAction> {
  const db = await getDb();
  const now = new Date().toISOString();

  const rowResult = await db.execute({
    args: [trackId],
    sql: `select ct.artists_json as artists_json, ct.label as label, ct.isrc as isrc,
                 ct.capture_status as capture_status, ct.capture_verification as capture_verification,
                 ct.source_audio_key as source_audio_key,
                 ct.source_audio_rejected as source_audio_rejected, ct.title as title,
                 (f.track_id is not null) as certified
          from tracks ct
          left join findings f on f.track_id = ct.track_id
          where ct.track_id = ? limit 1`,
  });
  const row = typedRow<VerifyRow>(rowResult.rows);

  if (!row || !row.source_audio_key || row.capture_status === WRONG_AUDIO_STATUS) {
    return "not-captured";
  }

  if (row.capture_verification === OPERATOR_VERIFIED) {
    return "operator-verified";
  }

  const certified = Number(row.certified) === 1;

  if (verdict === "match" || verdict === "no-preview") {
    const verification = verdict === "match" ? "preview-match" : "unverified";

    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [verification, now, trackId],
          sql: `update tracks set capture_verification = ?, capture_verified_at = ? where track_id = ?`,
        },
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { producer: "capture-verification" },
    );

    return verification;
  }

  if (certified) {
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [now, trackId],
          sql: `update tracks set capture_verification = 'mismatch', capture_verified_at = ? where track_id = ?`,
        },
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { producer: "capture-verification" },
    );

    return "flagged-finding";
  }

  const [archive, findingIsrcs, findingIdentity, artistIdsByTrack] = await Promise.all([
    readArchiveAffinity(),
    readFindingIsrcs(),
    readFindingIdentity(),
    readTrackArtistIds([trackId]),
  ]);
  const preAudio = preAudioPriority(
    { artists_json: row.artists_json, isrc: row.isrc, label: row.label, title: row.title },
    archive,
    findingIsrcs,
    findingIdentity.byMatchKey,
    artistIdsByTrack.get(trackId) ?? [],
  );
  const rejected = appendRejectedSha(
    row.source_audio_rejected,
    shaFromSourceAudioKey(row.source_audio_key),
    "backfill-mismatch",
    now,
  );

  const before = await readRowBuckets(trackId);

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [WRONG_AUDIO_STATUS, preAudio.priority, preAudio.duplicateOf, rejected, now, trackId],
        sql: `update tracks
          set capture_status = ?,
              ${CLEAR_EMBEDDING_SQL},
              nearest_finding_score = null,
              capture_priority = ?,
              duplicate_of_track_id = ?,
              source_audio_rejected = ?,
              capture_verification = 'mismatch',
              capture_verified_at = ?,
              catalogue_rank_corpus = null
          where track_id = ?`,
      },
      clearEmbeddingSatellite(trackId),
    ],
    [
      { subjectId: trackId, subjectType: "track" },
      ...dueWorkCatalogueRankRepairSubjects("capture-verification-quarantine"),
    ],
    {
      afterMaintenanceStatements: [repairRankableArtistsForTrackStatement(trackId)],
      producer: "capture-verification-quarantine",
    },
  );

  await applyCatalogueSummaryDelta(before, await readRowBuckets(trackId));

  return "quarantined-catalogue";
}
