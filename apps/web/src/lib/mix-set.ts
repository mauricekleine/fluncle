export {
  isSetToken,
  MAX_SET_LENGTH,
  MAX_TASTE_ARTISTS,
  mixReasonLabel,
  parseSetParam,
  parseTasteParam,
  serializeSet,
  serializeTaste,
  setToken,
} from "@fluncle/contracts/util/mix-set";

/**
 * Set-level `MusicPlaylist` JSON-LD makes a shared mix legible to crawlers. A member links to
 * Spotify when available because the playlist describes the recording; a `/log` URL would claim
 * Fluncle certification. A crawler-minted row with no store link carries no `url` claim.
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
