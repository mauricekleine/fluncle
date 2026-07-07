import { adminApiGet, adminApiPost } from "../api";

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

export type FollowArtistResult = {
  dryRun: boolean;
  failed: Array<{ error: string; platform: string; socialId: string }>;
  failedCount: number;
  followed: Array<{ artistId: string; artistName: string; platform: string; socialId: string }>;
  followedCount: number;
  ok: boolean;
  // Followable targets still unfollowed after this batch. The CLI loops until it's 0.
  remaining: number;
};

// One bounded pass of the auto-follow sweep (Epic B) via the admin API — the Worker
// follows a batch of high-confidence artists on YouTube (status auto/confirmed, idempotent
// by followed_at IS NULL, quota-paced). Spotify is excluded (its follow endpoint is
// dev-mode-gated for our app; Spotify championing is manual — see docs/ROADMAP.md).
// `--dry-run` reports what WOULD be followed without calling the platform or writing. Loop
// while `remaining > 0`.
export async function followArtistsCommand(
  limit: number,
  dryRun: boolean,
): Promise<FollowArtistResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  return adminApiPost<FollowArtistResult>(`/api/admin/artists/follow?${params.toString()}`);
}
