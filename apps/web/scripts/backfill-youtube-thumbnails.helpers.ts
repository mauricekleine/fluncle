// Pure helpers for the one-off YouTube Shorts thumbnail backfill
// (scripts/backfill-youtube-thumbnails.ts). They are split into this sibling
// module — with zero `lib/server` imports — so the unit test under
// src/test/backfill-youtube-thumbnails.helpers.test.ts (where the vitest suite
// includes tests from) can exercise the candidate-selection logic without
// dragging in the Turso client, the env machinery, or any network /
// process.env side effects.

// The cutoff: findings PUBLISHED BEFORE this commit show YouTube's auto-picked
// frame, because custom thumbnails landed with it. b16a5db (2026-06-13,
// "admin posting board + per-platform publishing"). A finding at or after the
// cutoff already got a custom thumbnail on its push, so it is skipped.
//
// LIMITATION (documented in the PR too): the YouTube Data API does NOT expose
// whether a video already carries a *custom* thumbnail — snippet.thumbnails
// always returns auto-generated renditions. So this predate-cutoff is the
// PRIMARY selector, not a thumbnail-state probe. Idempotency is fine regardless:
// re-running thumbnails.set with the same cover just re-sets the same image.
export const THUMBNAIL_SUPPORT_CUTOFF = new Date("2026-06-13T12:14:29+02:00");

/** A DB candidate finding: a published youtube `social_posts` row joined to its track. */
export type Candidate = {
  logId: string;
  title: string;
  // The finding's publish time — `social_posts.published_at` for the youtube
  // row, falling back to `tracks.added_at` (the notNull publish/add time; the
  // tracks table has no `published_at` column). ISO string.
  publishedAt: string;
};

/** An uploaded video as enumerated from the channel's uploads playlist. */
export type UploadedVideo = {
  videoId: string;
  title: string;
  // contentDetails.videoPublishedAt — ISO string, may be undefined for an
  // unprocessed upload.
  publishedAt: string | undefined;
};

/**
 * Normalize a title for matching: lowercase, strip punctuation/symbols to
 * spaces, collapse runs of whitespace, trim. So "Artist — Title (Remix)!" and
 * "artist  title  remix" compare equal. Diacritics are folded via NFKD so a
 * stylized upload title still matches the DB title.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Whether a finding's publish date predates custom-thumbnail support (and so is
 * a backfill candidate). Returns false for an unparseable date — we never want
 * to "fix" a finding we can't place in time.
 */
export function predatesThumbnailSupport(
  date: string | undefined,
  cutoff: Date = THUMBNAIL_SUPPORT_CUTOFF,
): boolean {
  if (!date) {
    return false;
  }

  const ms = Date.parse(date);

  if (Number.isNaN(ms)) {
    return false;
  }

  return ms < cutoff.getTime();
}

/**
 * Match a DB candidate to one of the channel's uploaded videos by NORMALIZED
 * title. When multiple uploads share the same normalized title (a re-upload, or
 * two findings of the same track), publish-time proximity breaks the tie: the
 * upload whose `publishedAt` is closest to the candidate's `publishedAt` wins.
 * An upload with no parseable publish time can still win an unambiguous (single)
 * title match, but loses any tiebreak to a dated sibling.
 *
 * Returns the matched videoId, or undefined when nothing matches.
 */
export function matchVideoIdForCandidate(
  candidate: Candidate,
  uploads: readonly UploadedVideo[],
): string | undefined {
  const wanted = normalizeTitle(candidate.title);

  if (!wanted) {
    return undefined;
  }

  const matches = uploads.filter((upload) => normalizeTitle(upload.title) === wanted);
  const first = matches[0];

  if (!first) {
    return undefined;
  }

  if (matches.length === 1) {
    return first.videoId;
  }

  const candidateMs = Date.parse(candidate.publishedAt);

  // Pick the upload whose publish time is nearest the candidate's. A finite
  // distance always beats an infinite one (an undated/unparseable upload).
  let best = first;
  let bestDistance = publishDistance(candidateMs, first.publishedAt);

  for (const upload of matches.slice(1)) {
    const distance = publishDistance(candidateMs, upload.publishedAt);

    if (distance < bestDistance) {
      best = upload;
      bestDistance = distance;
    }
  }

  return best.videoId;
}

function publishDistance(candidateMs: number, uploadPublishedAt: string | undefined): number {
  if (Number.isNaN(candidateMs) || !uploadPublishedAt) {
    return Number.POSITIVE_INFINITY;
  }

  const uploadMs = Date.parse(uploadPublishedAt);

  if (Number.isNaN(uploadMs)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.abs(uploadMs - candidateMs);
}
