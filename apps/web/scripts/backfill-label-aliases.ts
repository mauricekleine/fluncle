#!/usr/bin/env bun
/**
 * The label-aliases derivation — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as
 * part of `db:backfill`, AFTER `backfill-labels.ts` (it needs `tracks.label_id` resolved). The
 * `albums` rows it reads are minted inline now (the publish path + the catalogue crawler), and
 * `albums.record_label_raw` is written by the Apple sweep — so this step no longer depends on a
 * deploy-time album backfill. It DERIVES, it does not remember: every run recomputes alias
 * candidates from the stored Apple album facts, so there is no queue to drain and nothing to
 * bookkeep. The `backfill-labels.ts` precedent, which this is the twin of.
 *
 * ── WHAT IT DERIVES (RFC musickit-second-authority, U2a) ─────────────────────────────
 * U1 stored Apple's album `recordLabel` on `albums.record_label_raw`. This step reads it and,
 * for each album, cross-checks against the MusicBrainz label the crawled row already carries
 * (`tracks.label_id → labels`), then proposes an alias in `label_aliases`:
 *
 *   1. DISTRIBUTOR DENYLIST — a `recordLabel` that is a known distributor (Believe, The Orchard,
 *      …) never becomes an alias. Apple's `recordLabel` is very often the distributor, not the
 *      imprint, and a distributor agreeing with itself is not evidence about the label. Dropped.
 *   2. CROSS-SOURCE CORROBORATION — Apple's `recordLabel` becomes a `candidate` (`kind: name`)
 *      ONLY when it FOLD-agrees with a label the album's tracks already carry: same recording,
 *      two independent authorities agreeing over the ISRC. If its slug already equals the
 *      canonical label's, there is nothing to alias (skip). A lone Apple string that fold-agrees
 *      with NO known label is a `hint` (`kind: hint`) on the album's dominant label — a weaker
 *      lead for the operator, never an assertion.
 *
 * It NEVER writes `tracks.label` (immutable) or `labels.name` (operator display authority): it
 * only proposes rows the operator confirms or rejects on `/admin/labels`. `on conflict do
 * nothing` on the `(label_id, alias_slug, source)` unique index makes a re-run a no-op and never
 * reverts a `confirmed` ruling.
 *
 * Runs wherever `db:migrate` runs: the Cloudflare deploy environment provides
 * `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; locally they come from `.dev.vars`.
 */
import { type Client, createClient } from "@libsql/client";
import { labelFold, slugify } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDistributorLabel } from "../src/lib/label-distributors";

export type LabelAliasesBackfillResult = {
  /** Candidates minted this run (`kind: name` — Apple ⋂ MusicBrainz agree). */
  candidates: number;
  /** Denylisted `recordLabel`s dropped without a row. */
  dropped: number;
  /** Hints minted this run (`kind: hint` — Apple names a label the archive doesn't recognise). */
  hints: number;
};

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

/** One (album's Apple recordLabel, a known label on that album) pairing from the join. */
type AlbumLabelRow = {
  apple_raw: string;
  label_id: string;
  label_name: string;
  label_slug: string;
  n: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory
 * database with the real migrations applied.
 */
export async function backfillLabelAliases(client: Client): Promise<LabelAliasesBackfillResult> {
  const result: LabelAliasesBackfillResult = { candidates: 0, dropped: 0, hints: 0 };

  // Every album that carries an Apple `recordLabel`, joined to each label its tracks point at
  // (with a track count so the dominant label is deterministic). Bounded by Apple's coverage —
  // an album with no Apple facts, or no linked label, contributes no row.
  const rows = await client.execute({
    sql: `select a.id as album_id, a.record_label_raw as apple_raw,
                 l.id as label_id, l.name as label_name, l.slug as label_slug,
                 count(*) as n
          from albums a
          join tracks t on t.album_id = a.id
          join labels l on l.id = t.label_id
          where a.record_label_raw is not null and trim(a.record_label_raw) <> ''
          group by a.id, l.id
          order by a.id asc, n desc, l.name collate nocase asc`,
  });

  // Group the flat join back into one entry per album: its Apple recordLabel + its known labels,
  // dominant (most tracks) first.
  const byAlbum = new Map<string, { appleRaw: string; labels: AlbumLabelRow[] }>();

  for (const raw of rows.rows) {
    const albumId = asText(raw.album_id);
    const row: AlbumLabelRow = {
      apple_raw: asText(raw.apple_raw).trim(),
      label_id: asText(raw.label_id),
      label_name: asText(raw.label_name),
      label_slug: asText(raw.label_slug),
      n: Number(raw.n) || 0,
    };

    const entry = byAlbum.get(albumId);

    if (entry) {
      entry.labels.push(row);
    } else {
      byAlbum.set(albumId, { appleRaw: row.apple_raw, labels: [row] });
    }
  }

  const now = new Date().toISOString();

  for (const { appleRaw, labels } of byAlbum.values()) {
    const appleSlug = slugify(appleRaw);

    if (appleSlug === "") {
      continue;
    }

    // Guardrail 1: a distributor `recordLabel` never becomes an alias — dropped.
    if (isDistributorLabel(appleRaw)) {
      result.dropped += 1;
      continue;
    }

    const appleFold = labelFold(appleRaw);
    const foldMatch = labels.find((label) => labelFold(label.label_name) === appleFold);

    if (foldMatch) {
      // Same real label, two authorities agreeing. Only worth a row when Apple's spelling is
      // genuinely different (a new slug) — otherwise it already folds in and there is nothing
      // to protect from re-minting.
      if (appleSlug === foldMatch.label_slug) {
        continue;
      }

      result.candidates += await upsertAlias(client, now, {
        alias: appleRaw,
        aliasSlug: appleSlug,
        kind: "name",
        labelId: foldMatch.label_id,
      });
      continue;
    }

    // Guardrail 2: a lone Apple disagreement — a weaker lead on the album's dominant label.
    const dominant = labels[0];

    if (dominant) {
      result.hints += await upsertAlias(client, now, {
        alias: appleRaw,
        aliasSlug: appleSlug,
        kind: "hint",
        labelId: dominant.label_id,
      });
    }
  }

  return result;
}

/**
 * Insert one alias candidate, `on conflict do nothing` on `(label_id, alias_slug, source)` — so
 * a re-run never duplicates a candidate and never reverts a `confirmed` row. Returns 1 if a row
 * landed, 0 if one already existed.
 */
async function upsertAlias(
  client: Client,
  now: string,
  alias: { alias: string; aliasSlug: string; kind: "name" | "hint"; labelId: string },
): Promise<number> {
  const inserted = await client.execute({
    args: [`lba_${randomUUID()}`, alias.labelId, alias.alias, alias.aliasSlug, alias.kind, now],
    sql: `insert into label_aliases
            (id, label_id, alias, alias_slug, source, kind, status, created_at)
          values (?, ?, ?, ?, 'apple', ?, 'candidate', ?)
          on conflict (label_id, alias_slug, source) do nothing`,
  });

  return inserted.rowsAffected;
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
  const result = await backfillLabelAliases(client);

  console.log(
    `label aliases: ${result.candidates} candidates · ${result.hints} hints · ` +
      `${result.dropped} distributor(s) dropped.`,
  );
}

if (import.meta.main) {
  await main();
}
