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
