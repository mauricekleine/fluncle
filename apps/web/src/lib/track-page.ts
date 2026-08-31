// THE ARCHIVE TRACK DESTINATION (`/track/<trackId>`) — the client-safe half.
//
// Fluncle holds far more recordings than he has ever certified. A certified one is a FINDING and
// lives at `/log/<coordinate>` — that URL, that identifier, and that page are untouched by this
// module and by everything downstream of it. What had no destination at all was the rest of the
// archive: a `tracks` row the crawler or the freshness tap put there, rendered as a quiet row on an
// entity page and linking straight back out to a streaming service. This module defines the one
// thing that changes: those rows get a page of their own, at a permanent address.
//
// ── THE IDENTIFIER, AND WHY IT IS `tracks.track_id` ────────────────────────────────────────────
// The address is the row's own PRIMARY KEY. Four properties decided it, in this order:
//
//   1. PERMANENCE UNDER CORRECTION. A page's URL must not move when its metadata is fixed. Every
//      other candidate on the row is metadata: a slug of the title moves when the title is
//      re-normalized, an album-scoped path moves when the release group is corrected, and a
//      display name moves whenever a vendor changes its mind. `track_id` is assigned once at
//      insert and never rewritten — the crawler's `mb_<recording-mbid>` and the freshness tap's
//      `sp_<spotify-track-id>` are both deterministic functions of an identity that already
//      existed, so re-crawling collides on the key and writes nothing.
//
//   2. IT EXISTS FOR EVERY ROW. `tracks.isrc` is the better RECORDING anchor and it is what the
//      archive reconciles on — but it is NULLABLE, and the `isrc_attempted_at` stamp beside it
//      exists precisely because "we looked and there is none" is a real and common answer. An
//      ISRC-keyed URL would have to invent a second scheme for every row without one, which is
//      two identifier spaces for one kind of thing.
//
//   3. AN ISRC THAT ARRIVES LATER CHANGES NOTHING. Under an ISRC-keyed URL, the day a backfill
//      fills that column the page's address changes — a redirect Fluncle would owe forever, on a
//      column four separate fill paths write to. Under the PK, a late ISRC is what it should be:
//      one more fact the page prints. The ISRC is still served (in the page's structured data and
//      through `/identity`), it is simply not the address.
//
//   4. ONE RECORDING, ONE PAGE — even though an ISRC is not unique per ROW. The same recording
//      reaches the catalogue under several barcodes, so several `tracks` rows can legitimately
//      share one ISRC; an ISRC-keyed URL would have to pick one of them and would pick a different
//      one as the crawl grows. The archive already has an answer for that ambiguity and it is not
//      the URL: an operator stamps the twin `duplicate_of_track_id`, and the destination follows
//      that stamp with a permanent redirect to the principal (see `-track-page-data.ts`).
//
// The address is therefore GUESSABLE only in the sense that any primary key is: it is a stable
// opaque token, not a counter, and nothing behind it is private — every field the page prints is
// already public through `/api/v1`, the feeds, and the entity pages. There is no enumeration to
// defend, because there is nothing to enumerate TOWARD.
//
// ── WHAT THIS FILE MAY NOT IMPORT ─────────────────────────────────────────────────────────────
// Nothing from `lib/server/**` or `db/**`. A route's `loader`/`head` is bundled EAGERLY, so a
// single constant reached from one welds the `getDb` → `@libsql/client` → `drizzle-orm` chain onto
// every page's first paint (docs/client-bundle.md rule 1, build-enforced by the
// `fluncle-eager-chunk-purity` gate). The predicates that need SQL live in `lib/server/track-page.ts`
// and are stated ONCE there; what is here is arithmetic and strings.

import { siteUrl } from "./fluncle-links";

/** The path of one archive track's destination. The single place the URL shape is spelled. */
export function trackPagePath(trackId: string): string {
  return `/track/${encodeURIComponent(trackId)}`;
}

/** The absolute URL of one archive track's destination — canonical links, sitemap, JSON-LD. */
export function trackPageUrl(trackId: string): string {
  return `${siteUrl}${trackPagePath(trackId)}`;
}

/**
 * SUFFICIENT IDENTITY, the client-side half: can the archive NAME this recording?
 *
 * A destination exists for a row the archive can name — a title and at least one artist credit.
 * That is the whole definition, and it is deliberately the lowest honest bar: a page for a row
 * with no title is a page about nothing, and everything richer than a name is EVIDENCE, which
 * decides indexability rather than existence (see `lib/server/track-page.ts`).
 *
 * The server half adds the one thing a rendered row cannot see — the operator stamps
 * (`dismissed_at`, `duplicate_of_track_id`) — and the two agree because they are the same two
 * clauses written in two languages. This half is what a LIST row calls before it decides whether
 * to link into the destination at all, so a row the destination would refuse never gets a link.
 */
export function hasTrackPageIdentity(track: { artists: string[]; title: string }): boolean {
  return track.title.trim().length > 0 && track.artists.some((artist) => artist.trim().length > 0);
}
