// Pure, React-Native-free codec for the set builder's `?set=` + `?taste=` deep link, plus
// the reason-chip copy. A faithful port of apps/web/src/lib/mix-set.ts: THE URL IS THE
// STORAGE, and a set built on the phone opens on the web because both surfaces serialize a
// chain the same way. The web owns the canonical format; this mirror is pinned to it by
// mix-set.test.ts (an exact expected URL string) so the two can't drift.
//
// The device store (mix-store.ts) is the phone's own convenience — it survives an app
// restart — but the shareable, cross-surface truth is still the URL these helpers build.

import { type MixReason } from "@fluncle/contracts";
import { isLogId } from "@fluncle/contracts/log-id";
import { API_BASE } from "@/config";

/** The most tracks a set link carries (mirrors the web cap). */
export const MAX_SET_LENGTH = 32;

/** The most artists a taste seed carries — a seed, not a library. */
export const MAX_TASTE_ARTISTS = 10;

// A Spotify track id: 22 chars of base62 — the identity of a track Fluncle never certified,
// which by definition has no coordinate to be named by.
const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;

// An artist slug, as `artists.slug` mints them: lowercase alphanumerics and hyphens.
const ARTIST_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Is this token a valid `?set=` member — a finding's Log ID, or a Spotify track id? A chain
 * holds both kinds; the two grammars can't collide (a Log ID has dots, a Spotify id is 22
 * bare base62 chars), so one list carries both with no prefix or escape.
 */
export function isSetToken(token: string): boolean {
  return isLogId(token) || SPOTIFY_TRACK_ID.test(token);
}

/**
 * A track's `?set=` token: its coordinate when Fluncle certified it, else its Spotify id.
 * The single definition of "how a chain names a row", so the store, the rail exclusion, and
 * the share URL cannot disagree about what is in the set.
 */
export function setToken(track: { logId?: string; trackId: string }): string {
  return track.logId ?? track.trackId;
}

/**
 * Parse a `?set=` value — a comma-separated list of chain tokens — into a clean, ordered,
 * de-duplicated list. Junk is dropped, the list is capped at {@link MAX_SET_LENGTH}, and
 * order is preserved (a set is a sequence).
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

/** Serialize an ordered chain back to the `?set=` value. */
export function serializeSet(tokens: string[]): string {
  return tokens.join(",");
}

/**
 * Parse a `?taste=` value — a comma-separated list of artist slugs — into a clean,
 * de-duplicated seed, capped at {@link MAX_TASTE_ARTISTS}.
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

/** Serialize a taste seed back to the `?taste=` value. */
export function serializeTaste(slugs: string[]): string {
  return slugs.join(",");
}

/**
 * The shareable web URL for a set built on the phone — a byte-for-byte match of the web
 * ShareSetButton (`{siteUrl}/mix?set=…[&taste=…]&view=play`). `&view=play` lands the
 * recipient in the read-only set, from which "Chain your own set from here" hands them the
 * builder with the same taste already tuned. Tokens/slugs are URL-safe by construction (Log
 * IDs, base62 ids, and hyphen-slugs), so they are interpolated raw exactly as the web does.
 */
export function buildMixShareUrl(setTokens: string[], tasteSlugs: string[]): string {
  const set = serializeSet(setTokens);
  const taste = tasteSlugs.length > 0 ? `&taste=${serializeTaste(tasteSlugs)}` : "";

  return `${API_BASE}/mix?set=${set}${taste}&view=play`;
}

// The crew-facing reason-chip copy — the ONLY place a mixability reason becomes a human
// string, reused verbatim from the web mix-set.ts. No numbers ever (§3.0 invariant).
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
