import { siteUrl } from "./fluncle-links";
import { formatIsoDuration } from "./format";
import { definitionalProse, type LogProseInput } from "./log-prose";

// The log page's JSON-LD, pure: the route's head() reads from here, and the
// schema's description is the SAME string as the visible definitional block
// (schema that contradicts the page gets discounted).

export type LogSchemaInput = LogProseInput & {
  album?: string;
  albumImageUrl?: string;
  durationMs: number;
  isrc?: string;
  spotifyUrl: string;
  tiktokUrl?: string;
  title: string;
};

export function logPageUrl(logId: string): string {
  return `${siteUrl}/log/${encodeURIComponent(logId)}`;
}

export function musicRecordingJsonLd(track: LogSchemaInput, imageUrl: string): object {
  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    byArtist: track.artists.map((artist) => ({ "@type": "MusicGroup", name: artist })),
    datePublished: track.addedAt.slice(0, 10),
    description: definitionalProse(track),
    duration: formatIsoDuration(track.durationMs),
    genre: "Drum and Bass",
    // The Log ID in BOTH forms as identifiers (not alternateName): the bare
    // coordinate and the fluncle:// URI are the retrieval tokens.
    identifier: [
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: track.logId },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: `fluncle://${track.logId}` },
    ],
    image: imageUrl,
    ...(track.isrc ? { isrcCode: track.isrc } : {}),
    ...(track.album ? { inAlbum: { "@type": "MusicAlbum", name: track.album } } : {}),
    name: track.title,
    sameAs: [track.spotifyUrl, ...(track.tiktokUrl ? [track.tiktokUrl] : [])],
    url: logPageUrl(track.logId),
  };
}

export function breadcrumbsJsonLd(logId: string): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/log`, name: "The log", position: 2 },
      { "@type": "ListItem", name: logId, position: 3 },
    ],
  };
}
