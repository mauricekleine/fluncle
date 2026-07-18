// The label-image resolve sweep: give every label its OWN logo instead of a borrowed album
// cover. A bounded, idempotent, Worker-paced pass over the `labels` worklist that walks each
// label's external identity (MusicBrainz label search → its curated Discogs/Wikidata url-rels)
// and downloads its logo ONCE into our own R2, so every label surface (the /labels cards, the
// /label/<slug> page, search, the hover card) can lead with the real logo.
//
// ── THE FALLBACK LADDER (explicit, tested) ──────────────────────────────────────────────────
//   1. Discogs label image — labels are first-class on Discogs and `GET /labels/{id}` returns a
//      real logo (discogs.ts::fetchDiscogsLabelImage). The primary source.
//   2. Wikidata P154 (logo image) — off the MB label's Wikidata url-rel, via Commons. The
//      second rung: cheap because the QID is already in the url-rels we walk for Discogs.
//   3. THE FLOOR — no own image: `image_state='none'`, and every surface keeps rendering exactly
//      what it renders today (the freshest finding's cover). A tiny artist-run label with no
//      Discogs/Wikidata image degrades gracefully, never to an empty card.
//
// ── WHY WORKER-PACED (the shipped `fluncle-backfill` discipline) ─────────────────────────────
// The box holds no vendor keys, so the MusicBrainz walk + the authed Discogs fetches happen HERE
// (in the Worker) and the box `--no-agent` cron just drives one small batch per tick. MB is the
// shared 1 req/s client (musicbrainz.ts); Discogs is the shared authed gate (discogs.ts). Both
// report `rateLimited` honestly, and this sweep trips a circuit breaker on it — it STOPS the pass
// rather than marching the next label into the same wall. Per-label reliability lives on the row
// (`image_state` / `image_attempted_at` / `image_failures`): a resolved/none label is terminal
// and skipped forever; a transient failure backs off on a cooldown and is retried; a persistent
// one gives up (→ `none`) so it is never retried forever. Idempotent by construction — a second
// run over a fully-resolved archive fetches nothing.

import { type DiscogsLabelImage, fetchDiscogsLabelImage, parseDiscogsLabelUrl } from "./discogs";
import { getDb, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { MB_USER_AGENT, mbFetch } from "./musicbrainz";

// One bounded pass handles at most this many eligible labels. Each label costs a few
// serialized ~1.1s rate-limited calls (MB search + MB url-rels walk + the two Discogs fetches),
// so ~4 labels ≈ 25s stays comfortably inside the Worker/gateway request budget. The archive
// carries tens of labels, so the whole set drains in a couple of ticks.
const MAX_BATCH = 4;

// A label attempted within this window is skipped (the cooldown floor between two attempts on
// the SAME label) — a tight cron can't re-hit a label before the vendor budget recovers. Only
// `pending` labels that hit a transient failure ever carry a recent `image_attempted_at`; a
// resolved/none label is terminal and excluded regardless.
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

// After this many consecutive failures a label GIVES UP (→ `image_state='none'`, the cover
// floor), so a persistently-failing label is never retried forever.
const MAX_FAILURES = 5;

// The stored logo is stable (a label's logo rarely changes and a re-resolve only happens on an
// operator's deliberate reset), so it caches hard at the edge like the other found assets.
const LABEL_LOGO_CACHE_CONTROL = "public, max-age=604800, immutable";

// Cap a downloaded image (mirrors the Discogs client's own ceiling) — protects the isolate.
const MAX_LABEL_IMAGE_BYTES = 5_000_000;

// content-type → file extension for the R2 key. Unknown image types get a neutral extension.
const MIME_EXTENSION: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

function extensionForMime(mime: string): string {
  return MIME_EXTENSION[mime] ?? "img";
}

/** The R2 key a label's logo is stored at — served world-readable from found.fluncle.com. */
export function labelLogoKey(slug: string, mime: string): string {
  return `labels/${slug}.${extensionForMime(mime)}`;
}

/** One label's resolve outcome — the state machine the pass folds each label into. */
type ResolveOutcome =
  | { kind: "resolved"; imageKey: string; source: "discogs" | "wikidata" }
  | { kind: "none" }
  | { kind: "failed"; error: string }
  | { kind: "rate-limited" };

export type LabelImagesResolveResult = {
  dryRun: boolean;
  // Slugs given a logo this pass (or, in a dry run, the eligible worklist it WOULD resolve).
  resolved: string[];
  resolvedCount: number;
  // Slugs with no own image anywhere — floored to the cover (terminal `image_state='none'`).
  none: string[];
  noneCount: number;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // The slug cursor to resume from, or null once the worklist is drained (or a throttle-stop).
  nextCursor: string | null;
  // True when the pass STOPPED on a vendor rate-limit circuit breaker — the CLI stops looping
  // the cursor and the next tick resumes with a fresh window.
  rateLimited: boolean;
};

// ── MusicBrainz label identity walk ─────────────────────────────────────────────────────────

type MbLabelSearchResponse = { labels?: { id?: string; name?: string; score?: number }[] };
type MbUrlRel = { type?: string; url?: { resource?: string } };
type MbLabelDetail = { id?: string; relations?: MbUrlRel[]; error?: unknown };

/**
 * Casefold to a bare alphanumeric key for the exact label-name fold — verbatim the crawler's
 * `fold` (crawl.ts), so the sweep and the crawl resolve a label name to the SAME MBID. A free-
 * text MB query returns the entity even when its spelling differs ("Med School" for "Medschool");
 * the exactness lives in this fold, not in the query.
 */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * MusicBrainz label search → the MBID whose name folds exactly to ours (or null). Exported so the
 * label-lineage sweep (label-lineage.ts) resolves a label's identity the SAME way — one shared
 * search + exact fold, never two divergent copies.
 */
export async function searchMbLabelId(
  name: string,
): Promise<{ mbid: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbLabelSearchResponse>(
    `/label?query=${encodeURIComponent(name)}&limit=5`,
  );

  if (rateLimited) {
    return { mbid: null, rateLimited: true };
  }

  const want = fold(name);
  const match = (data?.labels ?? []).find(
    (candidate) => candidate.id && candidate.name && fold(candidate.name) === want,
  );

  return { mbid: match?.id ?? null, rateLimited: false };
}

/** A MusicBrainz label's curated url-rels → its Discogs label id + Wikidata QID (either null). */
async function walkMbLabelRels(
  mbid: string,
): Promise<{ discogsLabelId: number | null; wikidataQid: string | null; rateLimited: boolean }> {
  const { data, rateLimited } = await mbFetch<MbLabelDetail>(
    `/label/${encodeURIComponent(mbid)}?inc=url-rels`,
  );

  if (rateLimited) {
    return { discogsLabelId: null, rateLimited: true, wikidataQid: null };
  }

  let discogsLabelId: number | null = null;
  let wikidataQid: string | null = null;

  for (const relation of data?.relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    if (discogsLabelId === null) {
      const id = parseDiscogsLabelUrl(resource);

      if (id !== undefined) {
        discogsLabelId = id;
        continue;
      }
    }

    if (wikidataQid === null) {
      const match = resource.match(/wikidata\.org\/(?:wiki|entity)\/(Q\d+)/i);

      if (match?.[1]) {
        wikidataQid = match[1];
      }
    }
  }

  return { discogsLabelId, rateLimited: false, wikidataQid };
}

// ── Wikidata P154 (logo image) — the second rung of the ladder ───────────────────────────────

type WikidataEntityData = {
  entities?: Record<
    string,
    { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> }
  >;
};

/** Download an image URL → its bytes + mime, or undefined (non-image, empty, oversized, error). */
async function downloadImage(
  url: string,
  headers: Record<string, string>,
): Promise<DiscogsLabelImage | undefined> {
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.startsWith("image/")) {
    return undefined;
  }

  const bytes = await response.arrayBuffer();

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LABEL_IMAGE_BYTES) {
    return undefined;
  }

  return { bytes, mime: contentType.split(";")[0]?.trim() || "image/jpeg" };
}

/**
 * Fetch a label's logo via its Wikidata entity's P154 (logo image) claim → a Commons file,
 * served through Special:FilePath (bounded with `?width` so a huge original doesn't blow the
 * ceiling). Best-effort → undefined on any miss. Wikimedia asks for an identifiable UA (we reuse
 * the MB one). Commons needs no auth, so — unlike Discogs — this could technically be hotlinked;
 * we still re-host it for one consistent, self-owned serving path across the ladder.
 */
async function fetchWikidataLogoImage(qid: string): Promise<DiscogsLabelImage | undefined> {
  try {
    const response = await fetch(
      `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`,
      { headers: { "User-Agent": MB_USER_AGENT } },
    );

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as WikidataEntityData;
    const filename = data.entities?.[qid]?.claims?.P154?.[0]?.mainsnak?.datavalue?.value;

    if (typeof filename !== "string" || !filename.trim()) {
      return undefined;
    }

    const commonsUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
      filename,
    )}?width=600`;

    return await downloadImage(commonsUrl, { "User-Agent": MB_USER_AGENT });
  } catch (error) {
    logEvent("warn", "label-images.wikidata-failed", { error, qid });

    return undefined;
  }
}

// ── DB layer ─────────────────────────────────────────────────────────────────────────────────

type LabelWorkRow = {
  discogs_label_id: number | null;
  image_failures: number;
  mb_label_id: string | null;
  name: string;
  slug: string;
};

/**
 * One bounded page of the resolve worklist: `pending` labels not currently cooling down,
 * slug-cursored (the same opaque cursor convention as the artist backfills). A resolved/none
 * label is terminal and never selected; a transiently-failed label is excluded until its
 * cooldown elapses. Self-draining: as labels resolve they leave `pending`.
 */
async function listPendingLabels(
  limit: number,
  cursor: string | undefined,
): Promise<LabelWorkRow[]> {
  const db = await getDb();
  const cooldownBefore = new Date(Date.now() - COOLDOWN_MS).toISOString();

  const result = await db.execute({
    args: cursor ? [cooldownBefore, cursor, limit] : [cooldownBefore, limit],
    sql: cursor
      ? `select slug, name, mb_label_id, discogs_label_id, image_failures
         from labels
         where image_state = 'pending'
           and (image_attempted_at is null or image_attempted_at < ?)
           and slug > ?
         order by slug asc limit ?`
      : `select slug, name, mb_label_id, discogs_label_id, image_failures
         from labels
         where image_state = 'pending'
           and (image_attempted_at is null or image_attempted_at < ?)
         order by slug asc limit ?`,
  });

  return typedRows<LabelWorkRow>(result.rows);
}

/** Persist a resolved external id, non-clobbering (never overwrite one already stored). */
async function persistLabelMbLabelIdInternal(slug: string, mbLabelId: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [mbLabelId, slug],
    sql: `update labels set mb_label_id = ? where slug = ? and mb_label_id is null`,
  });
}

async function persistDiscogsLabelId(slug: string, discogsLabelId: number): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [discogsLabelId, slug],
    sql: `update labels set discogs_label_id = ? where slug = ? and discogs_label_id is null`,
  });
}

/**
 * The crawler's hook: persist the MusicBrainz label MBID it already resolves at walk time
 * (crawl.ts::expandSeedLabel). Non-clobbering, so it never fights the sweep. Exported so the
 * crawl's own module stamps the id it holds instead of throwing it away — the sweep then skips
 * the MB search for that label.
 */
export async function setLabelMbLabelId(slug: string, mbLabelId: string): Promise<void> {
  await persistLabelMbLabelIdInternal(slug, mbLabelId);
}

async function markResolved(slug: string, imageKey: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  // A resolved logo IS a visible change to the label's picture, so bump `updated_at`.
  await db.execute({
    args: [imageKey, now, now, slug],
    sql: `update labels
          set image_key = ?, image_state = 'resolved', image_failures = 0,
              image_attempted_at = ?, updated_at = ?
          where slug = ?`,
  });
}

async function markNone(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels
          set image_state = 'none', image_failures = 0, image_attempted_at = ?
          where slug = ?`,
  });
}

/**
 * Record a failed attempt: bump the failure streak + the attempt stamp (drives the cooldown
 * backoff). Past `MAX_FAILURES` the label GIVES UP (→ `none`), so it is never retried forever.
 * Touches only the reliability columns — no `updated_at`, no fan-out.
 */
async function recordFailure(slug: string, priorFailures: number): Promise<void> {
  const db = await getDb();
  const failures = priorFailures + 1;
  const giveUp = failures >= MAX_FAILURES;

  await db.execute({
    args: [failures, giveUp ? "none" : "pending", new Date().toISOString(), slug],
    sql: `update labels
          set image_failures = ?, image_state = ?, image_attempted_at = ?
          where slug = ?`,
  });
}

// ── The per-label resolve (the ladder) ────────────────────────────────────────────────────────

async function storeLogo(
  bucket: Pick<R2Bucket, "put">,
  slug: string,
  image: DiscogsLabelImage,
): Promise<string> {
  const key = labelLogoKey(slug, image.mime);

  await bucket.put(key, image.bytes, {
    httpMetadata: { cacheControl: LABEL_LOGO_CACHE_CONTROL, contentType: image.mime },
  });

  return key;
}

/**
 * Resolve ONE label's logo up the ladder. Walks its MB identity (reusing a crawler-persisted
 * MBID when present), reads the Discogs + Wikidata ids off the MB url-rels, then tries Discogs,
 * then Wikidata, and floors to `none` when neither has an image. Any exhausted vendor 429/503
 * returns `rate-limited` so the pass can circuit-break. Never throws — a thrown error becomes a
 * `failed` outcome the caller records with backoff.
 */
async function resolveOneLabel(
  row: LabelWorkRow,
  bucket: Pick<R2Bucket, "put">,
  discogsToken: string | undefined,
): Promise<ResolveOutcome> {
  try {
    let mbid = row.mb_label_id;
    let discogsLabelId = row.discogs_label_id;
    let wikidataQid: string | null = null;

    // 1. Identity: the MB label MBID (the crawler may have already persisted it).
    if (!mbid) {
      const search = await searchMbLabelId(row.name);

      if (search.rateLimited) {
        return { kind: "rate-limited" };
      }

      mbid = search.mbid;

      if (mbid) {
        await persistLabelMbLabelIdInternal(row.slug, mbid);
      }
    }

    // 2. Walk the MB url-rels for the Discogs id (persist if new) + the Wikidata QID (transient,
    //    used only for this pass's fallback). Walk whenever we have an MBID and no image yet, so
    //    even a partially-resolved label (Discogs id known, no image) can still reach Wikidata.
    if (mbid) {
      const rels = await walkMbLabelRels(mbid);

      if (rels.rateLimited) {
        return { kind: "rate-limited" };
      }

      wikidataQid = rels.wikidataQid;

      if (rels.discogsLabelId !== null && discogsLabelId === null) {
        discogsLabelId = rels.discogsLabelId;
        await persistDiscogsLabelId(row.slug, discogsLabelId);
      }
    }

    // 3. Discogs label image — the primary source.
    if (discogsLabelId !== null && discogsToken) {
      const { image, rateLimited } = await fetchDiscogsLabelImage(discogsLabelId, discogsToken);

      if (rateLimited) {
        return { kind: "rate-limited" };
      }

      if (image) {
        const imageKey = await storeLogo(bucket, row.slug, image);

        return { imageKey, kind: "resolved", source: "discogs" };
      }
    }

    // 4. Wikidata P154 — the second rung.
    if (wikidataQid) {
      const image = await fetchWikidataLogoImage(wikidataQid);

      if (image) {
        const imageKey = await storeLogo(bucket, row.slug, image);

        return { imageKey, kind: "resolved", source: "wikidata" };
      }
    }

    // 5. The floor: no own image anywhere. The surfaces keep rendering the freshest cover.
    return { kind: "none" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

// ── The pass ───────────────────────────────────────────────────────────────────────────────────

/**
 * One bounded, idempotent pass of the label-image resolve sweep. `bucket` is the world-served
 * R2 (`env.VIDEOS`, behind found.fluncle.com); the handler injects it (tests inject a fake). A
 * dry run reports the eligible worklist without any vendor call or write. Stops early on a vendor
 * rate-limit (circuit breaker) and returns `rateLimited: true` with a null cursor so the CLI
 * stops looping this tick.
 */
export async function resolveLabelImages(
  bucket: Pick<R2Bucket, "put">,
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LabelImagesResolveResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const rows = await listPendingLabels(batchLimit, cursor);

  const resolved: string[] = [];
  const none: string[] = [];
  const failed: Array<{ error: string; slug: string }> = [];
  let rateLimited = false;

  if (dryRun) {
    // Preview the eligible worklist without touching a vendor or the DB.
    for (const row of rows) {
      resolved.push(row.slug);
    }
  } else {
    const discogsToken = await readOptionalEnv("DISCOGS_USER_TOKEN");

    for (const row of rows) {
      const outcome = await resolveOneLabel(row, bucket, discogsToken);

      if (outcome.kind === "rate-limited") {
        // Circuit breaker: a vendor is actively throttling. Stop the pass; do NOT cool this
        // label down (it was throttled, not imageless) — the next tick retries it fresh.
        rateLimited = true;
        break;
      }

      if (outcome.kind === "resolved") {
        await markResolved(row.slug, outcome.imageKey);
        logEvent("info", "label-images.resolved", {
          imageKey: outcome.imageKey,
          slug: row.slug,
          source: outcome.source,
        });
        resolved.push(row.slug);
        continue;
      }

      if (outcome.kind === "none") {
        await markNone(row.slug);
        none.push(row.slug);
        continue;
      }

      // failed — back off (streak + cooldown), give up past MAX_FAILURES.
      await recordFailure(row.slug, row.image_failures);
      failed.push({ error: outcome.error, slug: row.slug });
    }
  }

  // Drained when the page came back short of the cap. On a throttle-stop, null the cursor so the
  // CLI stops looping this tick (the next tick resumes from the top; the cooldown re-skips the
  // labels already attempted this pass).
  const lastSlug = rows.at(-1)?.slug ?? null;
  const nextCursor = rateLimited || rows.length < batchLimit ? null : lastSlug;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    nextCursor,
    none,
    noneCount: none.length,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
  };
}
