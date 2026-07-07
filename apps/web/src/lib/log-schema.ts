import { logPageUrl, siteUrl } from "./fluncle-links";
import { formatIsoDuration } from "./format";
import { artistTitleLine, definitionalProse, type LogProseInput } from "./log-prose";
import { type MixtapeDTO } from "./mixtapes";

// Re-exported for callers that have always reached the log-URL builder through
// the log schema; the canonical definition now lives in fluncle-links.
export { logPageUrl };

// The log page's JSON-LD, pure: the route's head() reads from here, and the
// schema's description is the SAME string as the visible definitional block
// (schema that contradicts the page gets discounted).

export type LogSchemaInput = LogProseInput & {
  album?: string;
  albumImageUrl?: string;
  // Name → slug for the finding's artists (the resolved artist entities). Present
  // names get an `@id = <siteUrl>/artist/<slug>` stamped on their `byArtist`
  // MusicGroup node — the cross-page graph that reconciles recording→artist across
  // the whole site for crawlers + AI answer-engines (Unit 3, artist-relationship
  // RFC §3). A name with no entity degrades to a bare `{ @type, name }`.
  artistSlugs?: Record<string, string>;
  // The finding's Discogs release URL — a per-track `sameAs` (distinct from the
  // artist-level sameAs on /about). Present only when the Discogs lookup resolved.
  discogsReleaseUrl?: string;
  durationMs: number;
  isrc?: string;
  spotifyUrl: string;
  tiktokUrl?: string;
  title: string;
};

/** The `<siteUrl>/artist/<slug>` node id — the shared anchor of the @id graph. */
export function artistPageUrl(slug: string): string {
  return `${siteUrl}/artist/${slug}`;
}

// A `byArtist` MusicGroup node, stamped with the artist entity's `@id` when the
// name resolves to a slug — the id-less node today becomes the twin of the artist
// page's own `@id` (the cross-page graph).
function byArtistNode(
  name: string,
  artistSlugs: Record<string, string> | undefined,
): Record<string, unknown> {
  const slug = artistSlugs?.[name];

  return slug
    ? { "@id": artistPageUrl(slug), "@type": "MusicGroup", name }
    : { "@type": "MusicGroup", name };
}

export function musicRecordingJsonLd(
  track: LogSchemaInput,
  imageUrl: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    byArtist: track.artists.map((artist) => byArtistNode(artist, track.artistSlugs)),
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
    sameAs: [
      track.spotifyUrl,
      ...(track.tiktokUrl ? [track.tiktokUrl] : []),
      ...(track.discogsReleaseUrl ? [track.discogsReleaseUrl] : []),
    ],
    url: logPageUrl(track.logId),
  };
}

/**
 * Normalize a DB timestamp (or a bare date) to a full ISO 8601 datetime WITH a
 * timezone (the trailing `Z` = UTC) for schema.org. Google's VideoObject wants a
 * full datetime in `uploadDate` — a date-only value ("2026-06-29") trips GSC's
 * "Invalid datetime value for uploadDate" + "missing a timezone". Falls back to the
 * raw value if it can't be parsed (best-effort; never throws on the /log page).
 */
function uploadDateIso(value: string): string {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * The finding's VideoObject — the richer crawl signal on top of the working
 * og:video, emitted only when the finding carries a rendered video. The
 * description mirrors the visible definitional prose (schema that contradicts the
 * page gets discounted); `uploadDate` is the finding's freshest real timestamp,
 * as a full ISO 8601 datetime with timezone.
 */
export function videoObjectJsonLd(
  track: LogSchemaInput,
  {
    contentUrl,
    thumbnailUrl,
    uploadDate,
  }: { contentUrl: string; thumbnailUrl: string; uploadDate: string },
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    contentUrl,
    description: definitionalProse(track),
    name: artistTitleLine(track),
    thumbnailUrl,
    uploadDate: uploadDateIso(uploadDate),
    url: logPageUrl(track.logId),
  };
}

/**
 * The mixtape set video's VideoObject — parity with the finding VideoObject (the
 * crawl signal that gets the set video indexed like the rendered finding clips),
 * emitted only when the mixtape carries a set video (setVideoAt). uploadDate is
 * the set-video timestamp, as a full ISO 8601 datetime with timezone.
 */
export function mixtapeVideoObjectJsonLd(
  mixtape: MixtapeDTO,
  {
    contentUrl,
    thumbnailUrl,
    uploadDate,
  }: { contentUrl: string; thumbnailUrl: string; uploadDate: string },
): Record<string, unknown> {
  const logId = mixtape.logId as string;

  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    contentUrl,
    description: mixtape.note ?? `Fluncle drum & bass mixtape — ${mixtape.title}.`,
    name: mixtape.title,
    thumbnailUrl,
    uploadDate: uploadDateIso(uploadDate),
    url: logPageUrl(logId),
  };
}

export function mixtapeAlbumJsonLd(mixtape: MixtapeDTO): Record<string, unknown> {
  const logId = mixtape.logId as string;

  return {
    "@context": "https://schema.org",
    "@type": "MusicAlbum",
    albumProductionType: "https://schema.org/DJMixAlbum",
    byArtist: { "@id": `${siteUrl}/about`, "@type": "Person", name: "Fluncle" },
    description: mixtape.note,
    duration: mixtape.durationMs ? formatIsoDuration(mixtape.durationMs) : undefined,
    genre: "Drum and Bass",
    identifier: [
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: logId },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: `fluncle://${logId}` },
    ],
    image: mixtape.coverImageUrl,
    name: mixtape.title,
    sameAs: Object.values(mixtape.externalUrls).filter(Boolean),
    track: {
      "@type": "ItemList",
      itemListElement: mixtape.members.reduce<
        Array<{
          "@type": "ListItem";
          item: {
            "@type": "MusicRecording";
            byArtist: Array<{ "@type": "MusicGroup"; name: string }>;
            name: string;
            url: string;
          };
          position: number;
        }>
      >((items, member) => {
        if (member.logId) {
          items.push({
            "@type": "ListItem",
            item: {
              "@type": "MusicRecording",
              byArtist: member.artists.map((artist) => ({ "@type": "MusicGroup", name: artist })),
              name: member.title,
              url: logPageUrl(member.logId),
            },
            position: items.length + 1,
          });
        }

        return items;
      }, []),
    },
    url: logPageUrl(logId),
  };
}

export function breadcrumbsJsonLd(logId: string): Record<string, unknown> {
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

/** The artist page's identity + its confirmed off-site anchors, for `sameAs`. */
export type MusicGroupArtist = {
  imageUrl: string;
  mbid?: string;
  name: string;
  slug: string;
  // The PUBLIC (auto/confirmed) social URLs; candidates are already filtered out.
  socials: string[];
  spotifyUrl?: string;
  wikidataQid?: string;
};

/** One finding on the artist page, for the `track` ItemList of MusicRecordings. */
export type MusicGroupFinding = {
  artists: string[];
  logId: string;
  title: string;
};

// The identity graph's off-site anchors, ranked Wikidata > MusicBrainz > Spotify >
// the confirmed socials, de-duplicated (a spotify social row can repeat spotifyUrl).
function artistSameAs(artist: MusicGroupArtist): string[] {
  const ordered = [
    artist.wikidataQid ? `https://www.wikidata.org/wiki/${artist.wikidataQid}` : undefined,
    artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : undefined,
    artist.spotifyUrl,
    ...artist.socials,
  ];

  return [...new Set(ordered.filter((url): url is string => Boolean(url)))];
}

/**
 * The artist page's JSON-LD: a `MusicGroup` carrying its `@id` (the cross-page
 * graph anchor, twin of the `byArtist` node stamped on every `/log` page), its
 * `sameAs` identity graph, and a `track` → ItemList of the findings as
 * MusicRecordings (the same reducer shape as `mixtapeAlbumJsonLd`). No fabricated
 * portrait — `image` is the most-recent finding's cover (VOICE.md: never invent).
 */
export function musicGroupJsonLd(
  artist: MusicGroupArtist,
  findings: MusicGroupFinding[],
): Record<string, unknown> {
  const artistUrl = artistPageUrl(artist.slug);
  const sameAs = artistSameAs(artist);

  return {
    "@context": "https://schema.org",
    "@id": artistUrl,
    "@type": "MusicGroup",
    genre: "Drum and Bass",
    image: artist.imageUrl,
    name: artist.name,
    ...(sameAs.length > 0 ? { sameAs } : {}),
    track: {
      "@type": "ItemList",
      itemListElement: findings.reduce<
        Array<{
          "@type": "ListItem";
          item: {
            "@type": "MusicRecording";
            byArtist: Array<{ "@type": "MusicGroup"; name: string }>;
            name: string;
            url: string;
          };
          position: number;
        }>
      >((items, finding) => {
        items.push({
          "@type": "ListItem",
          item: {
            "@type": "MusicRecording",
            byArtist: finding.artists.map((name) => ({ "@type": "MusicGroup", name })),
            name: finding.title,
            url: logPageUrl(finding.logId),
          },
          position: items.length + 1,
        });

        return items;
      }, []),
    },
    url: artistUrl,
  };
}

/** Fluncle → Artists → the artist name, the artist page's breadcrumb. */
export function artistBreadcrumbsJsonLd(name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/artists`, name: "Artists", position: 2 },
      { "@type": "ListItem", name, position: 3 },
    ],
  };
}
