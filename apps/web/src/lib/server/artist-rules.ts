import { randomUUID } from "node:crypto";
import { parseSpotifyArtistId } from "./artist-resolution";
import {
  markCrawlProjectionRepairStatement,
  markCrawlProjectionRepairsFromSelectStatement,
} from "./crawl-due-work";
import { getDb, typedRows } from "./db";
import { type DueWorkStatement, markDueWorkSourceMaintenanceStatements } from "./due-work";
import { LabelNotFoundError } from "./labels";
import { mbFetch } from "./musicbrainz";

const ARTIST_RULE_LIMIT = 100;

/**
 * Two axes in one column. `allow`/`block` are ACQUISITION scope (what a future crawl takes);
 * `unlisted` is the one VISIBILITY verdict (the artist entity has no public page) and is inert at
 * crawl time. `unlisted` is valid only on a GLOBAL rule — see `LabelScopedUnlistedRuleError`.
 */
export type ArtistRuleVerdict = "allow" | "block" | "unlisted";
/** The verdicts a per-label rule may carry: acquisition scope only. */
export type LabelArtistRuleVerdict = "allow" | "block";
export type ArtistRuleSource = "operator" | "triage";

export type ArtistRule = {
  artistMbid: string;
  artistName: string;
  artistSpotifyId: null | string;
  checkedAt: null | string;
  createdAt: string;
  id: string;
  resolvedMbid: null | string;
  resolvedName: null | string;
  updatedAt: string;
  verdict: ArtistRuleVerdict;
};

export type LabelArtistRuleInput = {
  artistMbid: string;
  artistName: string;
  verdict: LabelArtistRuleVerdict;
};

export type GlobalArtistRuleInput = {
  artistMbid: string;
  artistName?: string;
  verdict: ArtistRuleVerdict;
};

export type UpdateArtistRuleInput = {
  checkedAt?: string;
  resolvedMbid?: null | string;
  resolvedName?: null | string;
};

type ArtistRuleRow = {
  artist_mbid: string;
  artist_name: string;
  artist_spotify_id: null | string;
  checked_at: null | string;
  created_at: string;
  id: string;
  resolved_mbid: null | string;
  resolved_name: null | string;
  updated_at: string;
  verdict: ArtistRuleVerdict;
};

type MbArtist = {
  id?: string;
  name?: string;
  relations?: Array<{ url?: { resource?: string } }>;
};

type LocalArtistBridgeRow = {
  name: string;
  spotify_artist_id: null | string;
};

type ResolvedArtistRuleIdentity = {
  artistName: null | string;
  artistSpotifyId: null | string;
};

const RULE_COLUMNS = `id, artist_mbid, artist_name, artist_spotify_id, verdict,
  resolved_mbid, resolved_name, checked_at, created_at, updated_at`;

/** A global rule already exists for this exact MusicBrainz artist identity. */
export class DuplicateGlobalArtistRuleError extends Error {}

/** A global rule omitted its name and neither MusicBrainz nor the local artist graph supplied one. */
export class MissingArtistRuleNameError extends Error {}

/** No global or per-label artist rule carries the requested globally unique id. */
export class ArtistRuleNotFoundError extends Error {}

/**
 * A per-label rule was handed the `unlisted` verdict. Visibility is a property of the artist's one
 * public page, not of any label, so a label-scoped `unlisted` could only ever be a silent no-op.
 * The contract's narrower per-label enum rejects it first; this is the server's own closed door.
 */
export class LabelScopedUnlistedRuleError extends Error {}

function toArtistRule(row: ArtistRuleRow): ArtistRule {
  return {
    artistMbid: row.artist_mbid,
    artistName: row.artist_name,
    artistSpotifyId: row.artist_spotify_id,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    id: row.id,
    resolvedMbid: row.resolved_mbid,
    resolvedName: row.resolved_name,
    updatedAt: row.updated_at,
    verdict: row.verdict,
  };
}

function spotifyArtistIdFromRelations(relations: MbArtist["relations"]): null | string {
  for (const relation of relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    const spotifyId = parseSpotifyArtistId(resource);

    if (spotifyId) {
      return spotifyId;
    }
  }

  return null;
}

/**
 * Resolve the write-time Spotify bridge from the artist's exact MB entity. MusicBrainz failure is
 * deliberately non-fatal: a rule still protects the catalogue by MBID, and the freshness tap
 * simply treats a null bridge as tap-blind. The local graph is the fallback for both the bridge and
 * an omitted global display name.
 */
async function resolveArtistRuleIdentity(artistMbid: string): Promise<ResolvedArtistRuleIdentity> {
  const path = `/artist/${encodeURIComponent(artistMbid)}?inc=url-rels`;
  const mbArtist = await mbFetch<MbArtist>(path)
    .then((result) => result.data)
    .catch(() => null);
  const mbName = mbArtist?.name?.trim() || null;
  const mbSpotifyId = spotifyArtistIdFromRelations(mbArtist?.relations);

  if (mbName && mbSpotifyId) {
    return { artistName: mbName, artistSpotifyId: mbSpotifyId };
  }

  const db = await getDb();
  const local = await db.execute({
    args: [artistMbid],
    sql: `select name, spotify_artist_id from artists
          where mbid = ?
          order by (spotify_artist_id is not null) desc, id asc
          limit 1`,
  });
  const row = typedRows<LocalArtistBridgeRow>(local.rows)[0];

  return {
    artistName: mbName ?? row?.name.trim() ?? null,
    artistSpotifyId: mbSpotifyId ?? row?.spotify_artist_id ?? null,
  };
}

function normalizedRequiredName(name: string): string {
  const normalized = name.trim();

  if (!normalized) {
    throw new MissingArtistRuleNameError("Artist name must not be blank.");
  }

  return normalized;
}

function isGlobalArtistRuleCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("artist_rules_global_artist_idx") ||
    message.includes("UNIQUE constraint failed: artist_rules.artist_mbid")
  );
}

async function assertLabelExists(labelId: string): Promise<void> {
  const db = await getDb();
  const label = await db.execute({
    args: [labelId],
    sql: `select id from labels where id = ? limit 1`,
  });

  if (!label.rows[0]) {
    throw new LabelNotFoundError(`No label with id ${labelId}.`);
  }
}

export async function listLabelArtistRules(labelId: string): Promise<ArtistRule[]> {
  await assertLabelExists(labelId);
  const db = await getDb();
  const result = await db.execute({
    args: [labelId, ARTIST_RULE_LIMIT],
    sql: `select ${RULE_COLUMNS} from artist_rules
          where label_id = ?
          order by artist_name collate nocase, id
          limit ?`,
  });

  return typedRows<ArtistRuleRow>(result.rows).map(toArtistRule);
}

/**
 * Replace one label's complete rule set atomically. Every remote identity walk finishes before the
 * transaction begins, so an MB miss cannot leave the existing set half-deleted. The rule write stamps
 * the crawl re-arm watermark and `updated_at`, never the human seed-ruling stamp (`ruled_at`).
 */
export async function replaceLabelArtistRules(
  labelId: string,
  rules: LabelArtistRuleInput[],
  source: ArtistRuleSource = "operator",
): Promise<ArtistRule[]> {
  if (rules.length > ARTIST_RULE_LIMIT) {
    throw new RangeError(`A label may carry at most ${ARTIST_RULE_LIMIT} artist rules.`);
  }

  // The input type forbids it; a JSON body decoded at the edge does not, so the check is runtime.
  const unlisted = rules.find((rule) => (rule.verdict as ArtistRuleVerdict) === "unlisted");

  if (unlisted) {
    throw new LabelScopedUnlistedRuleError(
      `The unlisted verdict is global-only; ${unlisted.artistMbid} cannot carry it under a label.`,
    );
  }

  const db = await getDb();
  await assertLabelExists(labelId);
  const prepared = await Promise.all(
    rules.map(async (rule) => ({
      artistMbid: rule.artistMbid,
      artistName: normalizedRequiredName(rule.artistName),
      artistSpotifyId: (await resolveArtistRuleIdentity(rule.artistMbid)).artistSpotifyId,
      verdict: rule.verdict,
    })),
  );
  const now = new Date().toISOString();
  const sourceVersion = `artist-rules-replace:${randomUUID()}`;
  const statements: DueWorkStatement[] = [
    markCrawlProjectionRepairsFromSelectStatement(
      "artist",
      {
        args: [labelId],
        sql: `select distinct artist_mbid as source_id from artist_rules where label_id = ?`,
      },
      { now, sourceVersion },
    ),
    { args: [labelId], sql: `delete from artist_rules where label_id = ?` },
  ];
  for (const rule of prepared) {
    statements.push({
      args: [
        `arl_${randomUUID()}`,
        rule.artistMbid,
        rule.artistName,
        rule.artistSpotifyId,
        rule.verdict,
        labelId,
        source,
        now,
        now,
      ],
      sql: `insert into artist_rules
              (id, artist_mbid, artist_name, artist_spotify_id, verdict, label_id, source,
               resolved_mbid, resolved_name, checked_at, rearmed_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, null, null, null, null, ?, ?)`,
    });
  }
  statements.push(
    {
      args: [now, now, labelId],
      sql: `update labels set scope_changed_at = ?, updated_at = ? where id = ?`,
    },
    ...markDueWorkSourceMaintenanceStatements([{ subjectId: labelId, subjectType: "label" }], {
      markerVersion: sourceVersion,
      now,
      producer: "label-artist-rules-replace",
    }),
    markCrawlProjectionRepairsFromSelectStatement(
      "label",
      { args: [labelId], sql: `select slug as source_id from labels where id = ?` },
      { now, sourceVersion },
    ),
    markCrawlProjectionRepairsFromSelectStatement(
      "artist",
      {
        args: [labelId],
        sql: `select distinct artist_mbid as source_id from artist_rules where label_id = ?`,
      },
      { now, sourceVersion },
    ),
  );

  await db.batch(statements, "write");

  return listLabelArtistRules(labelId);
}

export async function listArtistRules(): Promise<ArtistRule[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select ${RULE_COLUMNS} from artist_rules
          where label_id is null
          order by artist_name collate nocase, id`,
  });

  return typedRows<ArtistRuleRow>(result.rows).map(toArtistRule);
}

/**
 * Add ONE global rule. `artist_rules_global_artist_idx` is unique on `artist_mbid` where `label_id`
 * is null, so an artist carries at most ONE GLOBAL RULING and all three verdicts share that slot —
 * `unlisted` and a global `allow`/`block` are mutually exclusive today. Per-label rules are a
 * separate slot and coexist with any of them. The conflict names the verdict already holding the
 * slot, because "clear it first" is only actionable once the operator knows what he is clearing.
 */
export async function addArtistRule(input: GlobalArtistRuleInput): Promise<ArtistRule> {
  const db = await getDb();
  const existing = await db.execute({
    args: [input.artistMbid],
    sql: `select id, verdict from artist_rules
          where label_id is null and artist_mbid = ? limit 1`,
  });
  const held = typedRows<{ id: string; verdict: ArtistRuleVerdict }>(existing.rows)[0];

  if (held) {
    throw new DuplicateGlobalArtistRuleError(
      `A global artist rule already exists for ${input.artistMbid}: ${held.verdict}. ` +
        `An artist carries one global ruling — clear ${held.id} before setting another.`,
    );
  }

  const identity = await resolveArtistRuleIdentity(input.artistMbid);
  const suppliedName =
    input.artistName === undefined ? null : normalizedRequiredName(input.artistName);
  const artistName = suppliedName ?? identity.artistName;

  if (!artistName) {
    throw new MissingArtistRuleNameError(
      `No artist name was supplied or resolved for ${input.artistMbid}.`,
    );
  }

  const id = `arl_${randomUUID()}`;
  const now = new Date().toISOString();

  try {
    await db.batch(
      [
        {
          args: [
            id,
            input.artistMbid,
            artistName,
            identity.artistSpotifyId,
            input.verdict,
            now,
            now,
          ],
          sql: `insert into artist_rules
                  (id, artist_mbid, artist_name, artist_spotify_id, verdict, label_id, source,
                   resolved_mbid, resolved_name, checked_at, rearmed_at, created_at, updated_at)
                values (?, ?, ?, ?, ?, null, 'operator', null, null, null, null, ?, ?)`,
        },
        markCrawlProjectionRepairStatement("artist", input.artistMbid, {
          now,
          onlyIfPreviousStatementChanged: true,
          sourceVersion: `artist-rule-add:${randomUUID()}`,
        }),
      ],
      "write",
    );
  } catch (error) {
    if (isGlobalArtistRuleCollision(error)) {
      // The unique index caught a ruling written between the read above and this insert. It cannot
      // name the verdict without a second read on a failed path, so it states the law instead.
      throw new DuplicateGlobalArtistRuleError(
        `A global artist rule already exists for ${input.artistMbid}. ` +
          `An artist carries one global ruling — clear it before setting another.`,
      );
    }

    throw error;
  }

  const inserted = await db.execute({
    args: [id],
    sql: `select ${RULE_COLUMNS} from artist_rules where id = ? limit 1`,
  });
  const row = typedRows<ArtistRuleRow>(inserted.rows)[0];

  if (!row) {
    throw new Error(`Artist rule ${id} was inserted but could not be read back.`);
  }

  return toArtistRule(row);
}

/**
 * Every `/artist/<slug>` page one MusicBrainz identity owns.
 *
 * A visibility ruling flips exactly these pages, so it is exactly what the edge cache has to be
 * told to drop. One indexed read (`artists_mbid_idx`); the mbid is deliberately not unique on
 * `artists` (a double-mint is a row for the operator to merge, not a write error), so this can
 * legitimately return more than one slug.
 */
export async function artistSlugsForMbid(artistMbid: string): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistMbid],
    sql: `select slug from artists where mbid = ? order by slug asc`,
  });

  return typedRows<{ slug: string }>(result.rows).map((row) => row.slug);
}

/**
 * Remove one global rule, returning what it was so the caller can act on the removal — a removed
 * `unlisted` rule puts a page back on the site, which the edge cache has to be told about. The
 * delete stays idempotent: an already-absent id returns undefined rather than throwing.
 */
export async function removeArtistRule(
  id: string,
): Promise<undefined | { artistMbid: string; verdict: ArtistRuleVerdict }> {
  const db = await getDb();
  const existing = await db.execute({
    args: [id],
    sql: `select artist_mbid, verdict from artist_rules
          where id = ? and label_id is null limit 1`,
  });
  const removed = typedRows<{ artist_mbid: string; verdict: ArtistRuleVerdict }>(existing.rows)[0];
  const now = new Date().toISOString();
  const sourceVersion = `artist-rule-remove:${randomUUID()}`;
  await db.batch(
    [
      markCrawlProjectionRepairsFromSelectStatement(
        "artist",
        {
          args: [id],
          sql: `select artist_mbid as source_id from artist_rules
                where id = ? and label_id is null`,
        },
        { now, sourceVersion },
      ),
      {
        args: [id],
        sql: `delete from artist_rules where id = ? and label_id is null`,
      },
    ],
    "write",
  );

  return removed ? { artistMbid: removed.artist_mbid, verdict: removed.verdict } : undefined;
}

/**
 * Stamp MusicBrainz drift-audit bookkeeping on either scope of artist rule. The assignment list is
 * deliberately closed over the three audit columns; identity, verdict, scope, and re-arm state are
 * unreachable here, and unlike a whole-set replace this never touches the owning label.
 */
export async function updateArtistRule(
  id: string,
  input: UpdateArtistRuleInput,
): Promise<ArtistRule> {
  const assignments: string[] = [];
  const args: Array<null | string> = [];

  if (input.resolvedMbid !== undefined) {
    assignments.push("resolved_mbid = ?");
    args.push(input.resolvedMbid);
  }

  if (input.resolvedName !== undefined) {
    assignments.push("resolved_name = ?");
    args.push(input.resolvedName);
  }

  if (input.checkedAt !== undefined) {
    assignments.push("checked_at = ?");
    args.push(input.checkedAt);
  }

  if (assignments.length === 0) {
    throw new RangeError("Pass at least one artist-rule drift-audit field.");
  }

  const db = await getDb();
  const now = new Date().toISOString();
  const updated = await db.execute({
    args: [...args, now, id],
    sql: `update artist_rules
          set ${assignments.join(", ")}, updated_at = ?
          where id = ?`,
  });

  if (updated.rowsAffected === 0) {
    throw new ArtistRuleNotFoundError(`No artist rule with id ${id}.`);
  }

  const result = await db.execute({
    args: [id],
    sql: `select ${RULE_COLUMNS} from artist_rules where id = ? limit 1`,
  });
  const row = typedRows<ArtistRuleRow>(result.rows)[0];

  if (!row) {
    throw new Error(`Artist rule ${id} was updated but could not be read back.`);
  }

  return toArtistRule(row);
}
