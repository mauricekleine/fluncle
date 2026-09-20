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
  type MintLabelOutcome,
} from "@fluncle/contracts";
import { getDb, typedRows } from "./db";
import {
  ensureLabel,
  getLabelAdminItem,
  labelSlug,
  resolveConfirmedAliasLabelId,
  updateLabelSeedState,
} from "./labels";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";

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

/** What the mint did, plus the label in the operator's admin shape. */
export type MintLabelResult = { label: LabelAdminItem; outcome: MintLabelOutcome };

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
 * Throws {@link MusicbrainzLabelNotFoundError} when MusicBrainz has nothing under the MBID,
 * {@link MusicbrainzThrottledError} while MusicBrainz is throttling (unknown, not absent), and
 * {@link LabelMintIdentityConflictError} when the name's slug already belongs to a different
 * MusicBrainz label.
 */
export async function mintLabelFromMusicbrainz(
  mbLabelId: string,
  seedState?: LabelSeedState,
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

  if (storedMbid !== canonical) {
    throw new LabelMintIdentityConflictError(
      `"${name}" already belongs to MusicBrainz label ${storedMbid ?? "none"} — merge or rename first.`,
    );
  }

  await fillLabelFacts(labelId, {
    disambiguation: trimmedOrNull(data.disambiguation),
    foundedLocation: trimmedOrNull(data.area?.name),
    foundingDate: trimmedOrNull(data["life-span"]?.begin),
  });

  const outcome: MintLabelOutcome = priorId ? "adopted" : "minted";

  logEvent("info", "label-mint.resolved", { mbLabelId: canonical, outcome, slug });

  return { label: await ruleOrRead(labelId, seedState), outcome };
}
