// Pure helpers for the `/mix` set-builder: the `?set=` + `?taste=` deep-link codec, the
// reason-chip copy, and the set-level MusicPlaylist JSON-LD. Client-safe + side-effect-free
// so the route's `validateSearch`, the builder, and the tests all share one definition of
// "what a set link means".
//
// THE URL IS THE STORAGE, and that is the whole design. `/mix` is a free tool a stranger
// uses with no account, so a set and the taste behind it live in the query string: nothing
// to sign up for, nothing to migrate to their phone, no cookie to consent to, and no state
// on our side to keep. It also makes the surface viral for free — a seeded, ordered set IS
// its link, so sharing it is a copy-paste and opening it reproduces it exactly.
//
// (localStorage was the alternative and it loses on every count: it cannot be shared, it
// cannot be linked, it does not survive a browser change, and it would have needed a
// consent story. The one thing it buys — a seed that persists across visits — is worth less
// than a set that travels.)

import { type MixReason } from "@fluncle/contracts";
import { isLogId } from "./log-id";

/** The most tracks a `/mix` set link carries. */
export const MAX_SET_LENGTH = 32;

/** The most artists a taste seed carries — a seed, not a library. */
export const MAX_TASTE_ARTISTS = 10;

// A Spotify track id: 22 chars of base62. The identity of a track Fluncle has never
// certified, which by definition has no coordinate to be named by.
const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;

// An artist slug, as `artists.slug` mints them: lowercase alphanumerics and hyphens.
const ARTIST_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Is this token a valid `?set=` member — a finding's Log ID, or a Spotify track id?
 *
 * A CHAIN HOLDS BOTH KINDS, because the rail now offers both. A finding is named by its
 * coordinate (permanent, pretty, and already the identity every other Fluncle surface uses);
 * a track Fluncle never certified has no coordinate — that is what uncertified MEANS — so it
 * is named by the only stable id it has. The two grammars cannot collide (a Log ID has dots,
 * a Spotify id is 22 bare base62 chars), so one list carries both with no prefix or escape.
 */
export function isSetToken(token: string): boolean {
  return isLogId(token) || SPOTIFY_TRACK_ID.test(token);
}

/**
 * Parse the `?set=` param — a comma-separated list of chain tokens — into a clean, ordered,
 * de-duplicated list. Junk is dropped without a DB hit, the list is capped at
 * {@link MAX_SET_LENGTH}, and order is preserved (a set is a sequence). A mixtape coordinate
 * (`sector.F.n`) is not a track and fails `isLogId`, so it drops.
 */
export function parseSetParam(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of raw.split(",")) {
    const token = value.trim();

    if (isSetToken(token) && !seen.has(token)) {
      seen.add(token);
      out.push(token);

      if (out.length >= MAX_SET_LENGTH) {
        break;
      }
    }
  }

  return out;
}

/** Serialize an ordered chain back to the `?set=` param value. */
export function serializeSet(tokens: string[]): string {
  return tokens.join(",");
}

/**
 * A track's `?set=` token: its coordinate when Fluncle certified it, else its Spotify id.
 * The single definition of "how a chain names a row", so the builder, the loader and the
 * exclusion list cannot disagree about what is in the set.
 */
export function setToken(track: { logId?: string; trackId: string }): string {
  return track.logId ?? track.trackId;
}

/**
 * Parse the `?taste=` param — a comma-separated list of artist slugs — into a clean,
 * de-duplicated seed, capped at {@link MAX_TASTE_ARTISTS}. An unresolvable slug is not
 * rejected here (this is a pure guard, not a lookup); the server simply finds no tracks for
 * it and the seed is that much smaller.
 */
export function parseTasteParam(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of raw.split(",")) {
    const slug = value.trim().toLowerCase();

    if (ARTIST_SLUG.test(slug) && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);

      if (out.length >= MAX_TASTE_ARTISTS) {
        break;
      }
    }
  }

  return out;
}

/** Serialize a taste seed back to the `?taste=` param value. */
export function serializeTaste(slugs: string[]): string {
  return slugs.join(",");
}

// The crew-facing reason-chip copy — the ONLY place a mixability reason becomes a human
// string. No numbers ever (§3.0 invariant).
const REASON_LABEL: Record<MixReason["relationship"], string> = {
  adjacent: "Next key over",
  close_in_sound: "Close in sound",
  diagonal: "Diagonal key",
  distant: "Long stretch",
  energy: "Energy lift",
  relative: "Relative key",
  same_key: "Same key",
  tempo_match: "Tempo locked",
};

/** The reason chip's crew-facing label for a candidate row. */
export function mixReasonLabel(reason: MixReason): string {
  return REASON_LABEL[reason.relationship];
}

/**
 * The set-level `MusicPlaylist` JSON-LD (its members `MusicRecording`s) — the homepage
 * precedent, so a shared `/mix` link is a legible playlist to crawlers. A member links
 * to Spotify where the recording has one, certified or not: the playlist describes the
 * MUSIC, and a `/log` page is a claim about Fluncle rather than about the recording. A
 * crawler-minted row may have no store link at all — then the recording stands on its
 * name and artists, with no `url` claim.
 */
export function mixPlaylistJsonLd(
  chain: { artists: string[]; spotifyUrl?: string; title: string }[],
  pageUrl: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "MusicPlaylist",
    name: "A Fluncle mix",
    numTracks: chain.length,
    track: chain.map((track, index) => ({
      "@type": "MusicRecording",
      byArtist: track.artists.map((name) => ({ "@type": "MusicGroup", name })),
      name: track.title,
      position: index + 1,
      ...(track.spotifyUrl ? { url: track.spotifyUrl } : {}),
    })),
    url: pageUrl,
  };
}
