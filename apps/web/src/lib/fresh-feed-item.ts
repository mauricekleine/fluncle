// The ITEM CONTRACT every fresh feed renders, in one place. Three emitters serve the same
// release-ordered list in three envelopes — the whole-archive RSS (/fresh.xml), the whole-archive
// JSON Feed (/fresh.json), and the per-entity RSS bodies in ./fresh-feed-rss.ts — and all three
// must answer the same four questions identically: what an item is TITLED, where it POINTS, what
// its stable ID is, and what INSTANT its release date names. Held apart, those four answers were
// byte-identical copies in three files, so the two-tier rule below could drift in one envelope
// while the others held.
//
// The rule they share: a CERTIFIED finding links to its /log home; an UNCERTIFIED catalogue row
// links OUT to Spotify only, with no /log and no coordinate to borrow (DESIGN.md's Unlit Rule);
// a row with neither points nowhere. Every date is a RELEASE date, never a Found date (VOICE.md's
// Found Rule) — the feeds key on `release_date`.
//
// Envelope-specific rendering (XML escaping, JSON Feed keys, channel copy) stays with each
// emitter; only the shared answers live here.

import { logPageUrl } from "./fluncle-links";
import { type FreshTrack } from "./server/fresh";

/** `Artist, Artist — Title` — the tracklist line every feed leads its item with. */
export function itemTitle(track: FreshTrack): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * Where an item points. A certified finding's home is its own /log page (the citation surface the
 * archive owns); an uncertified row has no coordinate, so it links OUT to Spotify only, and a
 * certified straggler with no coordinate yet falls back to Spotify too. `undefined` when there is
 * nowhere honest to point — the item renders as a plain titled row.
 */
export function itemLink(track: FreshTrack): string | undefined {
  if (track.certified && track.logId) {
    return logPageUrl(track.logId);
  }
  return track.spotifyUrl;
}

/** A stable, unique id: the permalink when one exists, else a deterministic release urn (an
    uncertified row has no coordinate to borrow — the Unlit Rule holds even in the id). */
export function itemId(track: FreshTrack, link: string | undefined): string {
  return link ?? `urn:fluncle:release:${track.releaseDate}:${encodeURIComponent(itemTitle(track))}`;
}

/** Parse a `YYYY-MM-DD` release date as a UTC day. `undefined` when the value is absent/unparseable. */
export function releaseInstant(releaseDate: string): Date | undefined {
  if (!releaseDate) {
    return undefined;
  }
  const parsed = new Date(`${releaseDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
