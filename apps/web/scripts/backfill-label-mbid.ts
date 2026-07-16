#!/usr/bin/env bun
/**
 * THE LABEL-MBID ONE-OFF BACKFILL — operator-run, ONCE, by hand. NOT in the deploy chain.
 *
 * IT HITS PRODUCTION TURSO and it hits MUSICBRAINZ. Run it on the operator machine after this
 * migration ships:
 *   `FLUNCLE_TURSO_OP_ITEM="<item>" bun run --cwd apps/web scripts/backfill-label-mbid.ts`
 * Production credentials come from 1Password via `op`, NOT `.dev.vars` (in this repo that points at
 * the tiny LOCAL per-worktree dev DB). Point `FLUNCLE_TURSO_OP_ITEM` at the item holding the
 * production Turso credentials (the same var + item `db-pull-prod.ts` uses), so `op` must be
 * unlocked — that biometric unlock IS the human-in-the-loop gate on touching prod.
 *
 * WHY IT IS ONE-OFF, NOT A RECURRING DEPLOY STEP. The label MBID (`labels.mb_label_id`) is now the
 * DISCOVERED-label fold key, and it is populated INLINE from here forward: the catalogue crawler
 * folds + adopts it at walk time (both the seed path via `setLabelMbLabelId` and the discovered
 * path via `ensureLabel(name, mbLabelId)` — crawl.ts + lib/server/labels.ts). So there is nothing
 * to reconcile on every push. This script exists only to catch HISTORY up: labels that were minted
 * before the fold key existed (every publish-minted label, and the pre-catalogue archive) carry
 * `mb_label_id = NULL` until it stamps them.
 *
 * WHAT IT DOES, per label with no MBID yet:
 *   1. RESOLVE — asks the ONE shared, ~1 req/s MusicBrainz client (lib/server/musicbrainz.ts) for
 *      the label by NAME, and folds the results with the shared `labelFold` — the exact resolution
 *      `expandSeedLabel` uses at crawl time, so the two agree by construction. A free-text query
 *      (not a field-scoped `label:"…"`) because MusicBrainz spells "Medschool" as "Med School".
 *   2. STAMP — writes the resolved MBID fill-empty-only (`where id = ? and mb_label_id is null`),
 *      so a value the crawler already stamped is never clobbered and a re-run is harmless.
 *
 * IT NEVER MERGES. If two existing label rows resolve to the SAME MBID (a genuine duplicate that
 * slugified apart), stamping the second would repoint its public `/label/<slug>` URL — that is the
 * operator's call, not a script's. So the collision is LOGGED and the second row is LEFT ALONE with
 * `mb_label_id = NULL`. The inline fold prevents NEW duplicates; healing the historical ones is a
 * deliberate, human step. The label entity carries operator control (unlike an album), which is
 * exactly why nothing here rules on its behalf. See docs/label-entity.md.
 *
 * The scope is bounded — tens of labels — so the ~1 req/s pace is a few minutes, not a storm. If
 * MusicBrainz starts actively throttling, the run STOPS (it does not re-storm), and a later re-run
 * picks up where it left off (fill-empty-only makes that safe).
 */
import { type Client, createClient } from "@libsql/client/web";
import { labelFold } from "@fluncle/contracts/util/galaxy-slug";
import { mbFetch } from "../src/lib/server/musicbrainz";

/** Only the MusicBrainz `/label` search fields we consume. */
type MbLabelSearch = { labels?: { id?: string; name?: string; score?: number }[] };

/** A row from `labels` still lacking its MBID. */
type UnstampedLabel = { id: string; name: string; slug: string };

/** A duplicate the run refused to auto-merge: two rows resolving to one MBID. */
export type LabelMbidCollision = { mbLabelId: string; slug: string; wonBySlug: string };

export type LabelMbidBackfillResult = {
  /** Duplicates left alone for the operator to merge by hand. */
  collisions: LabelMbidCollision[];
  /** Labels MusicBrainz could not resolve — left NULL, no error. */
  unresolved: number;
  /** Rows this run stamped with a freshly resolved MBID. */
  stamped: number;
  /** True when MusicBrainz throttled us and the run stopped early. */
  throttled: boolean;
};

/** Coerce a libSQL scalar cell to text — these columns are TEXT, always strings. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Resolve one label NAME to its MusicBrainz label MBID via the shared rate-limited client, folding
 * candidates with the shared `labelFold` so "Medschool" matches MusicBrainz's "Med School". Returns
 * the MBID, `null` for no confident match, or the throttle signal so the caller can stop the run.
 */
export async function resolveLabelMbidByName(
  name: string,
): Promise<{ mbid: null | string; throttled: boolean }> {
  const { data, rateLimited } = await mbFetch<MbLabelSearch>(
    `/label?query=${encodeURIComponent(name)}&limit=5`,
  );

  if (rateLimited) {
    return { mbid: null, throttled: true };
  }

  const want = labelFold(name);
  const match = (data?.labels ?? []).find(
    (candidate) => candidate.id && candidate.name && labelFold(candidate.name) === want,
  );

  return { mbid: match?.id ?? null, throttled: false };
}

/**
 * The idempotent core, taking any libSQL client and an injectable resolver so a test can drive it
 * without a live MusicBrainz call.
 */
export async function backfillLabelMbids(
  client: Client,
  resolve: (name: string) => Promise<{ mbid: null | string; throttled: boolean }>,
): Promise<LabelMbidBackfillResult> {
  const result: LabelMbidBackfillResult = {
    collisions: [],
    stamped: 0,
    throttled: false,
    unresolved: 0,
  };

  // The MBIDs already claimed — the seed labels the crawler stamped, plus every row stamped this
  // run. A second row resolving to one of these is the collision this script refuses to merge.
  const claimed = new Map<string, string>();
  const existing = await client.execute({
    sql: `select slug, mb_label_id from labels where mb_label_id is not null`,
  });

  for (const row of existing.rows) {
    const mbid = asText(row.mb_label_id);
    const slug = asText(row.slug);

    if (mbid !== "" && slug !== "") {
      claimed.set(mbid, slug);
    }
  }

  const unstamped = await client.execute({
    sql: `select id, name, slug from labels where mb_label_id is null
          and name is not null and trim(name) <> '' order by slug asc`,
  });

  for (const row of unstamped.rows as unknown as UnstampedLabel[]) {
    const name = asText(row.name).trim();
    const slug = asText(row.slug);
    const id = asText(row.id);

    if (name === "" || slug === "" || id === "") {
      continue;
    }

    const { mbid, throttled } = await resolve(name);

    if (throttled) {
      // MusicBrainz is actively throttling — stop rather than re-storm. A re-run resumes safely.
      result.throttled = true;

      break;
    }

    if (!mbid) {
      result.unresolved += 1;

      continue;
    }

    const wonBySlug = claimed.get(mbid);

    if (wonBySlug && wonBySlug !== slug) {
      // Two rows want one MBID. Stamping this one would repoint its public URL — the operator's
      // call. Leave it NULL and record the collision.
      result.collisions.push({ mbLabelId: mbid, slug, wonBySlug });

      continue;
    }

    const updated = await client.execute({
      // Fill-empty-only: a value the crawler stamped between our read and this write is never
      // clobbered, and the unique index guards a genuine race.
      args: [mbid, new Date().toISOString(), id],
      sql: `update labels set mb_label_id = ?, updated_at = ?
            where id = ? and mb_label_id is null`,
    });

    if (updated.rowsAffected > 0) {
      result.stamped += 1;
      claimed.set(mbid, slug);
    }
  }

  return result;
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

/** Read one field of the prod-Turso 1Password item, exactly as `db-pull-prod.ts` does. */
async function readSecret(field: string): Promise<string> {
  try {
    const value = await Bun.$`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

async function main(): Promise<void> {
  if (!ITEM) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");
  // intMode:"bigint" keeps large integers exact; the script reads only text cells and `rowsAffected`
  // (always a JS number), so nothing here needs bigint narrowing.
  const client = createClient({ authToken, intMode: "bigint", url });
  const result = await backfillLabelMbids(client, resolveLabelMbidByName);

  console.log(
    `label-mbid backfill: ${result.stamped} stamped · ${result.unresolved} unresolved · ` +
      `${result.collisions.length} collisions${result.throttled ? " (STOPPED — throttled)" : ""}.`,
  );

  for (const collision of result.collisions) {
    console.log(
      `  collision: label "${collision.slug}" resolves to MBID ${collision.mbLabelId}, ` +
        `already held by "${collision.wonBySlug}" — left NULL, merge is the operator's call.`,
    );
  }
}

if (import.meta.main) {
  await main();
}
