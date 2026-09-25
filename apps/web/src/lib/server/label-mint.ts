import {
  type LabelAdminItem,
  type LabelSeedState,
  type LabelTakeOverResult,
  type MintLabelOutcome,
} from "@fluncle/contracts";
import {
  markCrawlNodeRepairsByUpdatedAtStatement,
  markCrawlProjectionRepairStatement,
  markCrawlProjectionRepairsFromSelectStatement,
} from "./crawl-due-work";
import { getDb, typedRows } from "./db";
import { markDueWorkSourceMaintenanceStatements } from "./due-work";
import {
  ensureLabel,
  getLabelAdminItem,
  hubCountsBySlug,
  LABELS_HUB_QUERY,
  labelSlug,
  resolveConfirmedAliasLabelId,
  updateLabelSeedState,
} from "./labels";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";
import { randomUUID } from "node:crypto";

export class MusicbrainzLabelNotFoundError extends Error {}

export class MusicbrainzThrottledError extends Error {}

export class LabelMintIdentityConflictError extends Error {}

export class LabelTakeOverSlugMismatchError extends Error {}

export class LabelTakeOverNotEmptyError extends Error {}

export type MintLabelResult = {
  label: LabelAdminItem;
  outcome: MintLabelOutcome;
  takenOver?: LabelTakeOverResult;
};

type MbLabelEntity = {
  area?: { name?: string } | null;
  disambiguation?: string | null;
  id?: string;
  "life-span"?: { begin?: string | null } | null;
  name?: string;
};

function trimmedOrNull(value: unknown): null | string {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function labelIdByMbid(mbid: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [mbid],
    sql: `select id from labels where mb_label_id = ? limit 1`,
  });

  return typedRows<{ id: string }>(result.rows)[0]?.id;
}

async function mbidOnLabel(labelId: string): Promise<null | string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId],
    sql: `select mb_label_id from labels where id = ? limit 1`,
  });

  return typedRows<{ mb_label_id: null | string }>(result.rows)[0]?.mb_label_id;
}

async function labelIdBySpelling(slug: string): Promise<string | undefined> {
  const aliasLabelId = await resolveConfirmedAliasLabelId(slug);

  if (aliasLabelId) {
    return aliasLabelId;
  }

  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id from labels where slug = ? limit 1`,
  });

  return typedRows<{ id: string }>(result.rows)[0]?.id;
}

async function fillLabelFacts(
  labelId: string,
  facts: {
    disambiguation: null | string;
    foundedLocation: null | string;
    foundingDate: null | string;
  },
): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [
      facts.foundingDate,
      facts.foundedLocation,
      facts.disambiguation,
      new Date().toISOString(),
      labelId,
    ],
    sql: `update labels
          set founding_date = coalesce(founding_date, ?),
              founded_location = coalesce(founded_location, ?),
              disambiguation = coalesce(disambiguation, ?),
              updated_at = ?
          where id = ?`,
  });
}

type LabelTakeOverRow = {
  discogs_label_id: null | number;
  id: string;
  image_key: null | string;
  mb_label_id: null | string;
  name: string;
  parent_label_id: null | string;
  seed_state: LabelSeedState;
  slug: string;
};

const seedResolverNodeId = (slug: string): string => `fluncle:label:${slug}`;
const labelBrowseNodeId = (mbLabelId: string): string => `musicbrainz:label:${mbLabelId}`;

const takenOverNote = (mbLabelId: string): string =>
  `label identity taken over; retired in favour of ${mbLabelId}`;

async function getLabelTakeOverRow(labelId: string): Promise<LabelTakeOverRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId],
    sql: `select id, slug, name, seed_state, mb_label_id, discogs_label_id, image_key,
                 parent_label_id
          from labels where id = ? limit 1`,
  });

  return typedRows<LabelTakeOverRow>(result.rows)[0];
}

async function takeOverLabelIdentity(
  row: LabelTakeOverRow,
  mbLabelId: string,
  facts: {
    disambiguation: null | string;
    foundedLocation: null | string;
    foundingDate: null | string;
  },
): Promise<LabelTakeOverResult> {
  const db = await getDb();
  const now = new Date().toISOString();
  const sourceVersion = `label-take-over:${randomUUID()}`;

  const nodeIds = [
    ...(row.mb_label_id ? [labelBrowseNodeId(row.mb_label_id)] : []),
    seedResolverNodeId(row.slug),
  ];
  const heldNodes = await db.execute({
    args: nodeIds,
    sql: `select id from crawl_frontier where id in (${nodeIds.map(() => "?").join(", ")})`,
  });
  const held = new Set(typedRows<{ id: string }>(heldNodes.rows).map((node) => node.id));
  const retiredNodeId =
    row.mb_label_id && held.has(labelBrowseNodeId(row.mb_label_id))
      ? labelBrowseNodeId(row.mb_label_id)
      : null;
  const rearmedNodeId = held.has(seedResolverNodeId(row.slug))
    ? seedResolverNodeId(row.slug)
    : null;

  const clearedFacts = [
    ...(row.discogs_label_id == null ? [] : ["discogsLabelId"]),
    ...(row.image_key == null ? [] : ["imageKey"]),
    ...(row.parent_label_id == null ? [] : ["parentLabelId"]),
  ];

  const statements: Array<{ args: Array<null | number | string>; sql: string }> = [];

  statements.push({
    args: [mbLabelId, facts.disambiguation, facts.foundedLocation, facts.foundingDate, now, row.id],
    sql: `update labels
            set mb_label_id = ?, disambiguation = ?, founded_location = ?, founding_date = ?,
                discogs_label_id = null, image_key = null, image_state = 'pending',
                image_updated_at = null, image_attempted_at = null, image_failures = 0,
                parent_label_id = null, lineage_state = 'pending', lineage_attempted_at = null,
                lineage_failures = 0, updated_at = ?
          where id = ?`,
  });

  statements.push({ args: [row.id], sql: `delete from artist_rules where label_id = ?` });

  if (retiredNodeId) {
    statements.push({
      args: [takenOverNote(mbLabelId), now, retiredNodeId],
      sql: `update crawl_frontier set note = ?, updated_at = ? where id = ?`,
    });
  }

  if (rearmedNodeId) {
    statements.push({
      args: [now, rearmedNodeId],
      sql: `update crawl_frontier set state = 'pending', cursor = 0, updated_at = ? where id = ?`,
    });
  }

  const touchedNodeIds = [
    ...(retiredNodeId ? [retiredNodeId] : []),
    ...(rearmedNodeId ? [rearmedNodeId] : []),
  ];

  const crawlRuleMaintenance = markCrawlProjectionRepairsFromSelectStatement(
    "artist",
    {
      args: [row.id],
      sql: `select distinct artist_mbid as source_id from artist_rules where label_id = ?`,
    },
    { now, sourceVersion },
  );
  const results = await db.batch(
    [
      crawlRuleMaintenance,
      ...statements,
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: row.id, subjectType: "label" }], {
        markerVersion: sourceVersion,
        now,
        producer: "label-take-over",
      }),
      markCrawlProjectionRepairStatement("label", row.slug, { now, sourceVersion }),
      ...(touchedNodeIds.length === 0
        ? []
        : [markCrawlNodeRepairsByUpdatedAtStatement(touchedNodeIds, sourceVersion, now)]),
    ],
    "write",
  );
  const sourceResults = results.slice(1, 1 + statements.length);

  return {
    clearedFacts,
    droppedRules: sourceResults[1]?.rowsAffected ?? 0,
    previousMbLabelId: row.mb_label_id,
    rearmedSeedNode: rearmedNodeId !== null,
    retiredFrontierNodes: retiredNodeId === null ? 0 : 1,
    slug: row.slug,
  };
}

async function assertTakeOverAllowed(row: LabelTakeOverRow): Promise<void> {
  if (row.seed_state === "enabled") {
    throw new LabelTakeOverNotEmptyError(
      `"${row.name}" (${row.slug}) is an ENABLED crawl seed — disable it before moving its identity, or merge instead (\`fluncle admin labels merge\`).`,
    );
  }

  const { trackCount } = await hubCountsBySlug(LABELS_HUB_QUERY, row.slug);

  if (trackCount > 0) {
    throw new LabelTakeOverNotEmptyError(
      `"${row.name}" (${row.slug}) holds ${trackCount} stored ${trackCount === 1 ? "track" : "tracks"} — that is a merge, not a take-over. Use \`fluncle admin labels merge\`.`,
    );
  }
}

async function readMintedLabel(labelId: string): Promise<LabelAdminItem> {
  const label = await getLabelAdminItem(labelId);

  if (!label) {
    throw new Error(`Label ${labelId} vanished between the mint and the read`);
  }

  return label;
}

async function ruleOrRead(labelId: string, seedState?: LabelSeedState): Promise<LabelAdminItem> {
  return seedState === undefined
    ? readMintedLabel(labelId)
    : updateLabelSeedState(labelId, seedState);
}

export async function mintLabelFromMusicbrainz(
  mbLabelId: string,
  seedState?: LabelSeedState,
  takeOverSlug?: string,
): Promise<MintLabelResult> {
  const requested = mbLabelId.trim().toLowerCase();
  const alreadyKnown = await labelIdByMbid(requested);

  if (alreadyKnown) {
    return { label: await ruleOrRead(alreadyKnown, seedState), outcome: "known" };
  }

  const { data, rateLimited } = await mbFetch<MbLabelEntity>(
    `/label/${encodeURIComponent(requested)}`,
  );

  if (rateLimited) {
    throw new MusicbrainzThrottledError(
      "MusicBrainz is rate-limiting the lookup — try again in a minute.",
    );
  }

  const name = trimmedOrNull(data?.name);

  if (!data || !name) {
    throw new MusicbrainzLabelNotFoundError(`MusicBrainz knows no label ${requested}.`);
  }

  const canonical = (trimmedOrNull(data.id) ?? requested).toLowerCase();

  if (canonical !== requested) {
    const knownByCanonical = await labelIdByMbid(canonical);

    if (knownByCanonical) {
      return { label: await ruleOrRead(knownByCanonical, seedState), outcome: "known" };
    }
  }

  const slug = labelSlug(name);

  if (!slug) {
    throw new MusicbrainzLabelNotFoundError(
      `MusicBrainz label ${canonical} has no name that can key a label row.`,
    );
  }

  const priorId = await labelIdBySpelling(slug);
  const labelId = await ensureLabel(name, canonical);

  if (!labelId) {
    throw new MusicbrainzLabelNotFoundError(
      `MusicBrainz label ${canonical} has no name that can key a label row.`,
    );
  }

  const storedMbid = await mbidOnLabel(labelId);
  const facts = {
    disambiguation: trimmedOrNull(data.disambiguation),
    foundedLocation: trimmedOrNull(data.area?.name),
    foundingDate: trimmedOrNull(data["life-span"]?.begin),
  };

  if (storedMbid !== canonical) {
    const conflicting = await getLabelTakeOverRow(labelId);
    const conflictingSlug = conflicting?.slug ?? slug;

    if (takeOverSlug === undefined) {
      throw new LabelMintIdentityConflictError(
        `"${name}" already belongs to MusicBrainz label ${storedMbid ?? "none"} — merge or rename first, or pass --take-over ${conflictingSlug} to re-point that row's identity (it must hold no tracks).`,
      );
    }

    if (!conflicting || conflicting.slug !== takeOverSlug.trim().toLowerCase()) {
      throw new LabelTakeOverSlugMismatchError(
        `--take-over named ${takeOverSlug.trim()}, but "${name}" conflicts with ${conflictingSlug}. Pass --take-over ${conflictingSlug} to move that row's identity.`,
      );
    }

    await assertTakeOverAllowed(conflicting);

    const takenOver = await takeOverLabelIdentity(conflicting, canonical, facts);

    logEvent("info", "label-mint.taken-over", {
      droppedRules: takenOver.droppedRules,
      mbLabelId: canonical,
      previousMbLabelId: takenOver.previousMbLabelId,
      slug: conflicting.slug,
    });

    return { label: await ruleOrRead(labelId, seedState), outcome: "taken_over", takenOver };
  }

  await fillLabelFacts(labelId, facts);

  const outcome: MintLabelOutcome = priorId ? "adopted" : "minted";

  logEvent("info", "label-mint.resolved", { mbLabelId: canonical, outcome, slug });

  return { label: await ruleOrRead(labelId, seedState), outcome };
}
