#!/usr/bin/env bun
/**
 * The labels backfill — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as
 * part of `db:backfill` on every push, right after `db:migrate` and before
 * `wrangler deploy`, so the `labels` DDL and the data it populates ship atomically (the
 * `backfill-plan-recording-mixtape.ts` precedent).
 *
 * Two steps, and the difference between them is the whole design:
 *
 *   1. RECONCILE — runs on EVERY deploy. Ensures a `labels` row exists for every distinct
 *      `tracks.label`, folded by slug (`Pilot.` and `Pilot` are one label). A new label
 *      enters `undecided` (the DDL default): never silently crawled, never silently
 *      dropped. It surfaces in the `/admin` attention queue as "a new label to rule on".
 *      This is the self-healing backstop behind the publish path's `ensureLabel` upsert.
 *
 *   2. THE BOOTSTRAP — runs EXACTLY ONCE, ever, gated on the `labels_seeded_at` marker in
 *      the `settings` table. It applies the operator's starting ruling (the-archive RFC,
 *      D7) to the labels that were in the archive when the entity landed, so day one
 *      doesn't open with 39 undecided rows. It is a ONE-TIME DATA STEP, not runtime logic:
 *      nothing in the Worker reads these lists, and after the marker is stamped this step
 *      never runs again — a label added tomorrow enters `undecided` like any other and
 *      waits for a human. The bootstrap also refuses to touch any row an operator has
 *      already ruled on (`ruled_at IS NOT NULL`), which makes a re-run harmless even if
 *      the marker were ever cleared by hand.
 *
 * ── THE RULING IS CRAWL SCOPE, NEVER STORAGE ────────────────────────────────────────
 * A label's `seed_state` says whether the FUTURE catalogue crawler may seed from it, and
 * nothing else. This script never deletes, hides, or rewrites a track, a finding, or any
 * stored row — it only mints label rows and stamps their seed state. See
 * docs/label-entity.md.
 *
 * Runs wherever `db:migrate` runs: the Cloudflare deploy environment provides
 * `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; locally they come from `.dev.vars`.
 */
import { type Client, createClient } from "@libsql/client";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The once-ever marker: present ⇒ the D7 bootstrap has already run. */
const SEED_MARKER_KEY = "labels_seeded_at";

/**
 * D7's starting ruling, as slugs (the label identity). These arrived on crossover remixes
 * and are not drum & bass imprints, so the crawler must not seed from them. Skipping them
 * removes them from the NEXT crawl's seeds. Their findings are untouched, forever.
 */
const BOOTSTRAP_DISABLED = [
  "anjunabeats",
  "armada-music",
  "atlantic-records-uk",
  "axtone-records",
  "counter-records",
  // The RFC names this imprint as "Tomorrowland Music / Experts Only"; both spellings, and
  // the combined one, resolve to the same ruling.
  "experts-only",
  "positiva",
  "tomorrowland-music",
  "tomorrowland-music-experts-only",
  "zerothree",
];

/**
 * D7's three deferrals — single-track imprints and one channel brand (UKF is a channel
 * rather than a label proper; seeding from it would cast a very wide net). They stay
 * `undecided` through the bootstrap so the operator rules on them from the queue.
 */
const BOOTSTRAP_UNDECIDED = ["chelou", "spiration-music", "ukf"];

export type LabelsBackfillResult = {
  bootstrapped: boolean;
  disabled: number;
  enabled: number;
  /** Tracks whose `label_id` pointer this run stamped (step 1b). */
  linked: number;
  minted: number;
  undecided: number;
};

/**
 * Every CONFIRMED alias as `alias_slug → canonical label_id` (RFC musickit-second-authority,
 * U2a). This is the re-mint guard: `tracks.label` is immutable, so a raw string whose spelling
 * the operator folded into another label would, on this deploy backfill, (1) re-mint its own
 * slug as a NEW label and (2) point its tracks at that duplicate — un-doing the fold every
 * deploy. Preloaded once and consulted before both the mint and the link below.
 */
export async function loadConfirmedAliases(client: Client): Promise<Map<string, string>> {
  const rows = await client.execute({
    sql: `select alias_slug, label_id from label_aliases where status = 'confirmed'`,
  });

  const bySlug = new Map<string, string>();

  for (const row of rows.rows) {
    const slug = asText(row.alias_slug);
    const labelId = asText(row.label_id);

    if (slug !== "" && labelId !== "") {
      bySlug.set(slug, labelId);
    }
  }

  return bySlug;
}

/**
 * Stamp `tracks.label_id` on every track that carries a label string, has no pointer yet,
 * and has a `labels` row to point at — the indexed edge the public `/label/<slug>` page
 * reads by (schema.ts). Shared shape with `backfill-albums.ts`.
 *
 * The fold happens here in TS (SQLite has no `slugify`), but what it folds is the UNLINKED
 * set — drained through `tracks_label_id_idx`, and empty on a steady-state deploy — never
 * the whole catalogue. This is the self-healing path by which a track written by ANY writer
 * that does not know the column exists (an admin update, a future catalogue crawler) is
 * linked into the graph.
 */
export async function linkTracksToLabels(
  client: Client,
  confirmedAliases?: Map<string, string>,
): Promise<number> {
  const aliases = confirmedAliases ?? (await loadConfirmedAliases(client));
  const unlinked = await client.execute({
    sql: `select label from tracks
          where label_id is null and label is not null and trim(label) <> ''
          group by label`,
  });

  let linked = 0;

  for (const row of unlinked.rows) {
    const raw = asText(row.label).trim();
    const slug = slugify(raw);

    if (slug === "") {
      continue;
    }

    const found = await client.execute({
      args: [slug],
      sql: `select id from labels where slug = ? limit 1`,
    });
    // A confirmed alias points a folded-away spelling at its canonical label; without this a
    // track carrying that raw string would stay unlinked (there is no `labels` row on its slug).
    const labelId = found.rows[0]?.id ?? aliases.get(slug);

    if (typeof labelId !== "string") {
      continue;
    }

    const updated = await client.execute({
      args: [labelId, raw],
      sql: `update tracks set label_id = ? where label_id is null and trim(label) = ?`,
    });

    linked += updated.rowsAffected;
  }

  return linked;
}

/** Coerce a libSQL scalar cell to text — these columns are TEXT, always strings. */
function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an
 * in-memory database with the real migrations applied.
 */
export async function backfillLabels(client: Client): Promise<LabelsBackfillResult> {
  const now = new Date().toISOString();
  const result: LabelsBackfillResult = {
    bootstrapped: false,
    disabled: 0,
    enabled: 0,
    linked: 0,
    minted: 0,
    undecided: 0,
  };

  // The re-mint guard: a slug the operator has folded into another label (a CONFIRMED alias) is
  // never re-minted here and its tracks link to the CANONICAL label, not a duplicate. Loaded
  // once for both the mint and the link below (U2a). Empty until the first alias is confirmed.
  const confirmedAliases = await loadConfirmedAliases(client);

  // ── 1. RECONCILE (every deploy) — a row per distinct tracks.label, folded by slug.
  const distinct = await client.execute({
    sql: `select tracks.label as label from findings join tracks on tracks.track_id = findings.track_id
          where tracks.label is not null and trim(tracks.label) <> ''
          group by tracks.label`,
  });

  // First spelling wins per slug. Stable across runs: a row is only ever inserted once.
  const bySlug = new Map<string, string>();

  for (const row of distinct.rows) {
    const raw = asText(row.label).trim();
    const slug = slugify(raw);

    if (slug !== "" && !confirmedAliases.has(slug) && !bySlug.has(slug)) {
      bySlug.set(slug, raw);
    }
  }

  for (const [slug, name] of bySlug) {
    const inserted = await client.execute({
      args: [`lbl_${randomUUID()}`, name, slug, now, now],
      sql: `insert into labels (id, name, slug, created_at, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (slug) do nothing`,
    });

    result.minted += inserted.rowsAffected;
  }

  // ── 1b. LINK (every deploy) — the `tracks.label_id` pointer for every track whose label
  // now has a row (or a confirmed alias). Runs AFTER the mint, so a label minted this very run
  // is pointed at.
  result.linked = await linkTracksToLabels(client, confirmedAliases);

  // ── 2. THE BOOTSTRAP (once, ever) — D7's starting ruling over the labels already in
  // the archive. Gated on the settings marker, so a label minted AFTER this deploy enters
  // `undecided` and waits for a human, exactly as designed.
  const marker = await client.execute({
    args: [SEED_MARKER_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });

  if (marker.rows.length > 0) {
    const states = await client.execute({
      sql: `select seed_state, count(*) as n from labels group by seed_state`,
    });

    for (const row of states.rows) {
      const n = Number(row.n) || 0;

      if (asText(row.seed_state) === "enabled") {
        result.enabled = n;
      } else if (asText(row.seed_state) === "disabled") {
        result.disabled = n;
      } else {
        result.undecided = n;
      }
    }

    return result;
  }

  const rows = await client.execute({
    // `ruled_at is null` is belt and braces: an operator ruling is never clobbered, even
    // if the marker were cleared by hand.
    sql: `select id, slug from labels where ruled_at is null`,
  });

  for (const row of rows.rows) {
    const slug = asText(row.slug);
    const state = BOOTSTRAP_DISABLED.includes(slug)
      ? "disabled"
      : BOOTSTRAP_UNDECIDED.includes(slug)
        ? "undecided"
        : "enabled";

    await client.execute({
      // `ruled_at` stays NULL: this is the machine's bootstrap, not a human's ruling.
      args: [state, now, asText(row.id)],
      sql: `update labels set seed_state = ?, updated_at = ? where id = ? and ruled_at is null`,
    });

    result[state] += 1;
  }

  await client.execute({
    args: [SEED_MARKER_KEY, now],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict (key) do nothing`,
  });

  result.bootstrapped = true;

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
  const result = await backfillLabels(client);

  console.log(
    `labels backfill: ${result.minted} minted · ${result.linked} linked · ${result.enabled} enabled, ` +
      `${result.disabled} skipped, ${result.undecided} undecided` +
      `${result.bootstrapped ? " (D7 bootstrap applied)" : ""}.`,
  );
}

if (import.meta.main) {
  await main();
}
