// Pure helpers for the `/mix` set-builder (RFC mixability-engine, Unit 2): the
// `?set=` deep-link codec, the reason-chip copy, and the set-level MusicPlaylist
// JSON-LD. Client-safe + side-effect-free so the route's `validateSearch`, the
// builder, and the tests all share one definition of "what a set link means".

import { type MixReason } from "@fluncle/contracts";
import { isLogId } from "./log-id";

/** The most findings a `/mix` set link carries (Decision 6: findings only, cap 32). */
export const MAX_SET_LENGTH = 32;

/**
 * Parse the `?set=` param — a comma-separated list of finding coordinates — into a
 * clean, ordered, de-duplicated Log ID list. Junk is dropped without a DB hit (the
 * `isLogId` guard), the list is capped at {@link MAX_SET_LENGTH}, and order is
 * preserved (a set is a sequence). A mixtape coordinate (`sector.F.n`) is not a
 * finding and fails `isLogId`, so it drops — findings only, by construction.
 */
export function parseSetParam(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of raw.split(",")) {
    const coord = value.trim();

    if (isLogId(coord) && !seen.has(coord)) {
      seen.add(coord);
      out.push(coord);

      if (out.length >= MAX_SET_LENGTH) {
        break;
      }
    }
  }

  return out;
}

/** Serialize an ordered chain back to the `?set=` param value. */
export function serializeSet(logIds: string[]): string {
  return logIds.join(",");
}

// The crew-facing reason-chip copy — the ONLY place a mixability reason becomes a
// human string. No numbers ever (§3.0 invariant). PENDING the morning copy review
// (Decision 5); these are the dogfood defaults.
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
 * The set-level `MusicPlaylist` JSON-LD (its members `MusicRecording`s) — the
 * homepage precedent, so a shared `/mix` link is a legible playlist to crawlers.
 */
export function mixPlaylistJsonLd(
  chain: { artists: string[]; logId?: string; spotifyUrl: string; title: string }[],
  pageUrl: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "MusicPlaylist",
    name: "A Fluncle mix",
    numTracks: chain.length,
    track: chain.map((finding, index) => ({
      "@type": "MusicRecording",
      byArtist: finding.artists.map((name) => ({ "@type": "MusicGroup", name })),
      name: finding.title,
      position: index + 1,
      url: finding.spotifyUrl,
    })),
    url: pageUrl,
  };
}
