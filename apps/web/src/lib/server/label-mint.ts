// THE OPERATOR'S THIRD DOOR — a `labels` row minted from a MusicBrainz label MBID.
//
// A label otherwise enters the archive only as a side effect of something else (docs/label-entity.md
// § How a label gets a row): the publish path mints one off a certified finding's label string, and
// the catalogue crawler mints one when a walk reaches a release naming a label with an MBID. Neither
// door opens for a label NOTHING HAS WALKED TO YET, which is exactly what an upstream MusicBrainz
// conflation split leaves behind — the drum & bass half lands on a brand-new entity, and for a
// one-release imprint no walk may ever reach it. This module is the operator naming the IDENTITY and
// the row existing.
//
// ── IT ADDS NO SECOND WRITE PATH ──────────────────────────────────────────────────────────────
// Everything here is a caller of machinery that already exists, deliberately:
//   - the ONE shared rate-limited MusicBrainz client (musicbrainz.ts) — MusicBrainz is 1 req/s per
//     client and a bare `fetch` would spend a budget the crawl and three sweeps share;
//   - `ensureLabel(name, mbLabelId)` (labels.ts) — the SAME connect-or-create the crawler folds
//     through, so the MBID fold and the fill-empty MBID adoption behave here exactly as they do on
//     a crawl, and a publish-minted row gains its identity instead of being duplicated;
//   - `updateLabelSeedState` (labels.ts) — the ONE write that moves `seed_state`, so an optional
//     ruling stamps `ruled_at` + the re-arm watermark identically to `update_label`.
//
// The facts it carries (disambiguation, founding place, founding date) are written FILL-EMPTY-ONLY
// with the same `coalesce` shape the lineage sweep uses (label-lineage.ts), so a mint can never
// overwrite what an operator or a sweep already established. MusicBrainz's `country` is the ISO code
// of the same area whose NAME lands in `founded_location`, and its `type` ("Original Production",
// "Imprint") has no column on `labels` — the row carries neither, and nothing is added for them.
//
// It rules nothing on its own: a new row lands at the table's `undecided` default, so a minted label
// is never silently crawled and never silently dropped — it arrives in the operator's `label-review`
// queue like every other unruled label.

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

/** MusicBrainz knows no label under this MBID (or the lookup came back empty). */
export class MusicbrainzLabelNotFoundError extends Error {}

/** MusicBrainz is actively throttling — the answer is UNKNOWN, not absent. */
export class MusicbrainzThrottledError extends Error {}

/**
 * The MusicBrainz name's slug already belongs to a row folded on a DIFFERENT MusicBrainz label.
 * Two real labels share a spelling; minting would either duplicate or quietly re-point an identity,
 * so the mint stops and asks (the `merge_label` stop-and-ask precedent).
 */
export class LabelMintIdentityConflictError extends Error {}

/**
 * `takeOverSlug` named a row that is NOT the one the mint collided with. A take-over re-points an
 * identity, so it is honoured only for the exact conflicting row — a typo must never move a
 * bystander label onto a MusicBrainz entity nobody meant for it.
 */
export class LabelTakeOverSlugMismatchError extends Error {}

/**
 * The named row cannot give up its identity: it holds stored tracks, or it is a live crawl seed.
 * A row with tracks is a MERGE (the tracks must travel to a row that keeps its own identity), and
 * an `enabled` row is mid-subscription, so its ruling comes down before its identity moves.
 */
export class LabelTakeOverNotEmptyError extends Error {}

/** What the mint did, plus the label in the operator's admin shape (and a take-over's summary). */
export type MintLabelResult = {
  label: LabelAdminItem;
  outcome: MintLabelOutcome;
  takenOver?: LabelTakeOverResult;
};

/**
 * The default `/ws/2/label/<mbid>` lookup body — every field below rides it with no `inc=`, so the
 * mint costs exactly ONE MusicBrainz request.
 */
type MbLabelEntity = {
  area?: { name?: string } | null;
  disambiguation?: string | null;
  id?: string;
  "life-span"?: { begin?: string | null } | null;
  name?: string;
};

/** A non-blank trimmed string, or null — the shape every fill-empty-only fact is stored as. */
function trimmedOrNull(value: unknown): null | string {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The `labels.id` folded on this MBID, or undefined. One seek on the UNIQUE `mb_label_id` index. */
async function labelIdByMbid(mbid: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [mbid],
    sql: `select id from labels where mb_label_id = ? limit 1`,
  });

  return typedRows<{ id: string }>(result.rows)[0]?.id;
}

/** The MBID a row currently carries (null when it carries none), or undefined when there is no row. */
async function mbidOnLabel(labelId: string): Promise<null | string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId],
    sql: `select mb_label_id from labels where id = ? limit 1`,
  });

  return typedRows<{ mb_label_id: null | string }>(result.rows)[0]?.mb_label_id;
}

/** The row this MusicBrainz name would resolve to today — a confirmed alias first, then the slug. */
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

/**
 * Carry MusicBrainz's identity facts onto the row FILL-EMPTY-ONLY (`coalesce` per column, the
 * lineage sweep's shape), and bump `updated_at` because the founding line is visible on the page. A
 * call with nothing to add still costs one bounded primary-key write; it changes no value.
 */
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

// ── THE TAKE-OVER: re-point a trackless row's identity instead of refusing ────────────────────
// The conflict above is the right default, and one upstream shape earns an explicit way through.
// A MusicBrainz split moves a conflated label's drum & bass catalogue onto a NEW entity that keeps
// the ORIGINAL's NAME; Fluncle's row for that name still points at the original, which now holds
// only the foreign catalogue (a US folk label, an LA punk band). The row named "X" in the archive
// should simply BE the drum & bass X. `takeOverSlug` says so out loud, and nothing else does — the
// take-over is never inferred from the shape of the collision.
//
// ── WHAT RIDES ALONG WITH THE NAME, AND WHAT BELONGS TO THE OLD IDENTITY ──────────────────────
// The row keeps its `id`, its `slug` and its `name`, so everything keyed on the NAME travels with
// it and every public URL holds:
//   - `label_aliases` — alternate SPELLINGS of the name, and the confirmed ones are what stop the
//     immutable `tracks.label` free-text re-minting the slug. They ride along.
//   - `bio` (+ its status/provenance/gate columns) — a paragraph about the label under this name.
//     It rides along; a bio that has gone stale is the bio engine's fill-empty-only problem.
//   - the CHILD labels (`labels.parent_label_id` pointing AT this row) — the reverse edge follows
//     the name, so the imprints under it stay under it.
//   - `label_releases_*` — the Spotify freshness tap queries by label NAME, never by MBID, so its
//     cadence columns describe the name and stay.
//   - the two maintained hub counters — the guard below proves the row holds no tracks, so both
//     are already zero and there is nothing to move.
// What does NOT ride along is everything walked FROM the replaced MusicBrainz entity:
//   - `artist_rules` scoped to this label roster the OLD identity's acts, so they are DROPPED and
//     reported, exactly as `merge_label` drops the losing row's set rather than unioning it.
//   - `discogs_label_id` + the logo (`image_*`) came off the old entity's curated url-rels.
//   - `parent_label_id` (this row's OWN parent) came off the old entity's label-rels.
//   The last two are cleared and their sweeps re-armed to `pending`, so the label-images and
//   label-lineage sweeps re-walk them from the NEW identity instead of keeping a stranger's logo.

/** The conflicting row, in the shape the take-over guard and its transaction read. */
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

/**
 * A frontier node's deterministic id is `<source>:<kind>:<external_id>` (crawl.ts `frontierId`,
 * which is module-private there). The seed RESOLVER node keys on the label slug; the node that
 * actually browses a label's releases keys on its MBID.
 */
const seedResolverNodeId = (slug: string): string => `fluncle:label:${slug}`;
const labelBrowseNodeId = (mbLabelId: string): string => `musicbrainz:label:${mbLabelId}`;

/** The note stamped on the node the replaced identity was walked under. Greppable, and inert. */
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

/**
 * Re-point ONE trackless row's `mb_label_id` onto the minted entity, atomically.
 *
 * In one `db.batch(_, "write")` (the `mergeLabel` precedent, so a crash can never half-apply an
 * identity move): the MBID moves, MusicBrainz's disambiguation/area/life-span OVERWRITE what the
 * row carried (the row is changing identity, so fill-empty-only would preserve the stranger's
 * facts), the old entity's derived facts are cleared and their sweeps re-armed, and the label's
 * artist rules are deleted.
 *
 * THE FRONTIER. A node keyed on the OLD MBID would otherwise keep browsing the stranger's releases
 * the next time the label is enabled, and the seed RESOLVER node — which mints the MBID's browse
 * node exactly once and then sits `done` — would never mint the new entity's. So the old browse
 * node is stamped retired (a `note`, never a delete: the walk history stays readable) and the
 * resolver is re-armed to `pending`, the two moves `reseed-label.ts` makes for the namesake repair.
 * The crawl's own re-arm join already refuses a node whose `external_id` is not the label's current
 * `mb_label_id` (crawl.ts `rearmSeedLabels`), so the retired node is inert by construction and the
 * stamp is the readable record of why. A row that was never enabled has NEITHER node and there is
 * nothing to retire — the statements are conditional on the nodes the frontier actually holds.
 */
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

  // Only the columns that actually carried the old entity's answer are reported as cleared, so the
  // operator reads what he lost rather than a constant list.
  const clearedFacts = [
    ...(row.discogs_label_id == null ? [] : ["discogsLabelId"]),
    ...(row.image_key == null ? [] : ["imageKey"]),
    ...(row.parent_label_id == null ? [] : ["parentLabelId"]),
  ];

  const statements: Array<{ args: Array<null | number | string>; sql: string }> = [];

  // 0: the identity move. The three MusicBrainz facts OVERWRITE (this is not a mint's coalesce),
  //    and every column derived from the replaced entity is cleared with its sweep re-armed to
  //    `pending` so label-images and label-lineage re-walk the NEW identity.
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
  // 1: the label's artist rules roster the OLD identity's acts. Dropped, never carried.
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
  // The rules' artist projections have to be read BEFORE the delete removes the rows.
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

/**
 * The take-over's TWO refusals, both server-side and both about the row rather than the request.
 *
 * A row holding stored tracks is a MERGE: its tracks have to travel to a row that keeps its own
 * identity, which is exactly what `merge_label` does and exactly what re-pointing an MBID under
 * them does not. The count is the maintained `renderable_track_count` read through the hub helper
 * every label surface already gates on (`tracks.label_id` pointers, certified and catalogue alike).
 *
 * An `enabled` row is a live crawl subscription: its seed resolver may be mid-walk, so the ruling
 * comes down first and the identity moves second. Passing `seedState` in the same call still works
 * — the ruling is applied AFTER the identity move, so a take-over can enable the new entity.
 */
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

/** Read the label back in the operator shape — it must be there; the id came from a write. */
async function readMintedLabel(labelId: string): Promise<LabelAdminItem> {
  const label = await getLabelAdminItem(labelId);

  if (!label) {
    throw new Error(`Label ${labelId} vanished between the mint and the read`);
  }

  return label;
}

/** Apply the operator's optional ruling through the ONE seed-state write, else read the row back. */
async function ruleOrRead(labelId: string, seedState?: LabelSeedState): Promise<LabelAdminItem> {
  return seedState === undefined
    ? readMintedLabel(labelId)
    : updateLabelSeedState(labelId, seedState);
}

/**
 * Mint (or find) the `labels` row for one MusicBrainz label MBID, and optionally rule on it.
 *
 * IDEMPOTENT by construction: an MBID that already keys a row short-circuits before the MusicBrainz
 * call and comes back `known` — a re-run spends no request and writes no fact. An omitted
 * `seedState` leaves a new row at the `undecided` default and leaves an existing row's ruling
 * untouched, so re-running the command can never un-rule a label.
 *
 * `takeOverSlug` is the operator's explicit way through the identity conflict: it names the row
 * whose `mb_label_id` should be RE-POINTED onto the minted entity instead of the call refusing.
 * It is read only on the conflict path, so passing it on any other call changes nothing — including
 * the idempotent `known` short-circuit, which comes back `known` with or without it.
 *
 * Throws {@link MusicbrainzLabelNotFoundError} when MusicBrainz has nothing under the MBID,
 * {@link MusicbrainzThrottledError} while MusicBrainz is throttling (unknown, not absent),
 * {@link LabelMintIdentityConflictError} when the name's slug already belongs to a different
 * MusicBrainz label and no take-over was asked for, {@link LabelTakeOverSlugMismatchError} when the
 * named slug is not the conflicting row, and {@link LabelTakeOverNotEmptyError} when that row holds
 * tracks or is a live crawl seed.
 */
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

  // MusicBrainz's OWN spelling of the id is what the crawler would store, so a merged/redirected
  // MBID folds on the entity that answered rather than on the string the operator typed.
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

  // Whether a row already wore this spelling decides the OUTCOME, and it has to be asked BEFORE the
  // fold — afterwards the two cases are indistinguishable.
  const priorId = await labelIdBySpelling(slug);
  const labelId = await ensureLabel(name, canonical);

  if (!labelId) {
    throw new MusicbrainzLabelNotFoundError(
      `MusicBrainz label ${canonical} has no name that can key a label row.`,
    );
  }

  // The fold is fill-empty-only on the MBID, so a row already folded on a DIFFERENT label keeps its
  // own identity and hands it straight back. Saying "adopted" then would be a lie about the archive.
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

    // A take-over is honoured for the EXACT conflicting row and nothing else. The operator names
    // the row he means, and the server checks he named the one the mint actually collided with.
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

    // The ruling lands AFTER the identity move, through the same seed-state write every other path
    // uses, so an operator may enable the new entity in the same command.
    return { label: await ruleOrRead(labelId, seedState), outcome: "taken_over", takenOver };
  }

  await fillLabelFacts(labelId, facts);

  const outcome: MintLabelOutcome = priorId ? "adopted" : "minted";

  logEvent("info", "label-mint.resolved", { mbLabelId: canonical, outcome, slug });

  return { label: await ruleOrRead(labelId, seedState), outcome };
}
