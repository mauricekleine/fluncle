import { adminApiGet, adminApiPost } from "../api";

// ── The voiced bio: the entity-bio engine (thin HTTP client) ──────────────────
// The entity sibling of `admin tracks note`: author the artist's/label's bio through the
// agent-tier `describe_*` route (the MODEL authors it in the box cron; the CLI just posts
// the gated text). Fills an empty bio only; an operator bio is never clobbered.

/** One row of the bio worklist: an entity with findings but no bio yet. */
export type EntityBioWorkItem = { id: string; name: string; slug: string };

/**
 * The Worker-paced bio DRAFT: the assembled grounding the box authors from. The Worker runs
 * the Firecrawl gather (its key) + pulls the logged finding titles (its DB) and returns a
 * ready-to-author prompt + its provenance version. `found:false` is an unresolved slug.
 */
export type EntityBioDraft = {
  findingCount: number;
  found: boolean;
  hasFacts: boolean;
  name: string;
  prompt: string;
  promptVersion: number;
};

/** What a describe call returns: the stored (or dry-run/skipped) bio + its slug. */
export type EntityBioResult = {
  bio: string;
  // True on a --dry-run: the voice gate ran, nothing was stored.
  dryRun?: boolean;
  ok: boolean;
  // True when a bio already existed and the fill-empty-only guard refused to clobber it.
  skipped?: boolean;
  slug: string;
};

type BioBody = { bio: string; dryRun?: boolean; promptVersion?: number };

/** Build the POST body shared by both entity describe commands. */
export function buildBioBody(options: {
  bio: string;
  dryRun?: boolean;
  promptVersion?: number;
}): BioBody {
  const body: BioBody = { bio: options.bio };

  if (options.dryRun) {
    body.dryRun = true;
  }

  if (typeof options.promptVersion === "number") {
    body.promptVersion = options.promptVersion;
  }

  return body;
}

// Author + store one artist's bio (the voice-gated, fill-empty-only write). The box's
// future bio cron drives this per row; the operator runs it ad-hoc. `--dry-run` runs the
// voice gate and reports the verdict without storing anything.
export async function describeArtistCommand(
  slug: string,
  options: { bio: string; dryRun?: boolean; promptVersion?: number },
): Promise<EntityBioResult> {
  return adminApiPost<EntityBioResult>(
    `/api/admin/artists/${encodeURIComponent(slug)}/bio`,
    buildBioBody(options),
  );
}

// Trigger the Worker's bio-draft grounding for one artist: the Firecrawl gather + finding
// titles + the assembled `describe_artist` prompt, returned ready-to-author. The box's bio
// sweep calls this per queued entity, then runs `claude -p` on the returned prompt.
export async function draftArtistBioCommand(slug: string): Promise<EntityBioDraft> {
  return adminApiGet<EntityBioDraft>(`/api/admin/artists/${encodeURIComponent(slug)}/bio-draft`);
}

// The BIO queue: artists with findings but no bio yet, oldest first — the worklist the
// `describe_artist` cron drains (each row is a `admin artists describe <slug>`).
export async function artistsBioQueueCommand(limit: number): Promise<EntityBioWorkItem[]> {
  const response = await adminApiGet<{ artists: EntityBioWorkItem[]; ok: boolean }>(
    `/api/admin/artists/bio-queue?limit=${limit}`,
  );

  return response.artists;
}

// ── Artist social resolution (Unit 2.1) ──────────────────────────────────────

/** One row of the resolve worklist: an artist awaiting social resolution. */
export type UnresolvedArtist = {
  id: string;
  name: string;
};

export type ArtistsResolveQueueResult = {
  artists: UnresolvedArtist[];
  nextCursor: string | null;
  ok: boolean;
};

/** A resolved social (MB url-rels walk or Firecrawl gap-fill). */
export type ResolvedArtistSocial = {
  platform: string;
  source: string;
  url: string;
};

export type ArtistResolveResult = {
  artistId: string;
  // The artist's MusicBrainz id + Wikidata QID captured onto the artist row
  // during the walk (null when MB had no match / the artist carried no KG anchor).
  mbid: string | null;
  ok: boolean;
  // True when MusicBrainz throttled the walk mid-flight (the sweep retries the
  // artist on the next tick rather than treating the partial result as final).
  rateLimited: boolean;
  socials: ResolvedArtistSocial[];
  socialsCount: number;
  wikidataQid: string | null;
};

// A bounded page of the resolve worklist (artists with `resolved_at IS NULL`),
// oldest-first by id. The sweep reads this, then calls `resolveArtistCommand`
// per row. Cursor-paged by artist id — pass the prior page's `nextCursor` to
// resume; it comes back null when the queue is drained.
export async function listArtistsCommand(
  limit: number,
  cursor?: string,
): Promise<ArtistsResolveQueueResult> {
  const params = new URLSearchParams({ limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiGet<ArtistsResolveQueueResult>(`/api/admin/artists?${params.toString()}`);
}

// Trigger the Worker's social resolution for one artist: the MB url-rels walk +
// the Firecrawl /v2/extract gap-fill for TikTok + missing YouTube. Idempotent per
// artist (re-resolving stamps timestamps). MB rows land as `status=auto` (trusted);
// Firecrawl rows as `status=candidate` (operator-confirm before public).
export async function resolveArtistCommand(artistId: string): Promise<ArtistResolveResult> {
  return adminApiPost<ArtistResolveResult>(
    `/api/admin/artists/${encodeURIComponent(artistId)}/resolve`,
  );
}

// ── The similar-artists precompute sweep (D6) ─────────────────────────────────
// The artist-graph sibling of `admin catalogue rank`: one tick of the sweep that keeps the
// `/artist/<slug>` "similar artists" rail off the page's hot path. The CLI is a thin pacer —
// the Worker owns the vector arithmetic; `remaining > 0` means run it again.

/** One `rank_artists` tick's summary — the JSON line a cron reads. */
export type RankArtistsSummary = {
  centroidsComputed: number;
  centroidsRemoved: number;
  edgesWritten: number;
  logicVersion: string;
  remaining: number;
};

/**
 * One tick of the similar-artists sweep. `fluncle admin artists rank [--limit <n>]`.
 *
 * Recomputes up to `limit` stale artist centroids (the mean over EVERY embedded track that
 * credits the artist — findings AND catalogue) and re-ranks each one's top-K sonic neighbours
 * in SQL, then purges any orphan centroid. Idempotent, resume-safe, a no-op on a settled graph.
 */
export async function rankArtistsCommand(options: {
  limit?: string;
}): Promise<{ summary: RankArtistsSummary }> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
  const response = await adminApiPost<{ ok: true; summary: RankArtistsSummary }>(
    "/api/admin/artists/rank",
    limit ? { limit } : {},
  );

  return { summary: response.summary };
}

export type ArtistsBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  // The feed cursor to resume from on the next pass, or null when the queue is
  // drained. The endpoint handles only a bounded pass per request (each finding
  // requires a Spotify re-fetch), so the CLI loops this until null.
  nextCursor: string | null;
  ok: boolean;
  skipped: string[];
  skippedCount: number;
  upserted: string[];
  upsertedCount: number;
};

export type ArtistImagesBackfillResult = {
  dryRun: boolean;
  failed: Array<{ artistId: string; error: string }>;
  failedCount: number;
  filled: string[];
  filledCount: number;
  // The feed cursor to resume from on the next pass, or null when the queue is
  // drained. Each pass batch-fetches one Spotify `/v1/artists` page, so the CLI
  // loops this until null.
  nextCursor: string | null;
  ok: boolean;
  // Artists Spotify has no image for — left null (a monogram tile renders), not failed.
  skipped: string[];
  skippedCount: number;
};

// One bounded pass of the artist-avatar backfill via the admin API — the Worker
// fetches the largest Spotify profile image for artists missing one and stamps
// `artists.image_url`. Idempotent + self-draining (an imaged artist drops out of the
// queue). `--dry-run` reports which artists would be filled without touching the DB.
// Pass the prior pass's `nextCursor` to resume; the CLI loops until it comes back null.
export async function backfillArtistImagesCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistImagesBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistImagesBackfillResult>(
    `/api/admin/backfill/artist-images?${params.toString()}`,
  );
}

// One bounded pass of the artist-entity backfill via the admin API — the Worker
// re-fetches each eligible finding's Spotify track metadata and upserts `artists`
// + `track_artists`. Findings that already have a `track_artists` row are skipped
// (idempotent). `--dry-run` reports which findings would be upserted without
// touching the DB. Pass the prior pass's `nextCursor` to resume; the CLI loops
// until it comes back null.
export async function backfillArtistsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistsBackfillResult>(`/api/admin/backfill/artists?${params.toString()}`);
}
