#!/usr/bin/env bun
/**
 * THE LABEL-MBID ONE-OFF BACKFILL — operator-run, ONCE, by hand. NOT in the deploy chain.
 *
 * IT HITS PRODUCTION TURSO and it hits MUSICBRAINZ. Run it on the operator machine after this
 * migration ships:
 *   `bun run --cwd apps/web scripts/backfill-label-mbid.ts`
 * It reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally, `.dev.vars`).
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
import { type Client, createClient } from "@libsql/client";
import { labelFold } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });
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
