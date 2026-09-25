import { fluncleEntityId, logPageUrl, siteUrl } from "./fluncle-links";
import { trackPageUrl } from "./track-page";
import { formatIsoDuration } from "./format";
import { artistTitleLine, definitionalProse, type LogProseInput } from "./log-prose";
import { type MixtapeDTO } from "./mixtapes";
import { deriveRemixerNames, fold } from "./server/track-match";

export { logPageUrl };

export type LogSchemaInput = LogProseInput & {
  album?: string;
  albumImageUrl?: string;

  appleMusicUrl?: string;

  artistSlugs?: Record<string, string>;

  discogsReleaseUrl?: string;
  durationMs: number;
  isrc?: string;

  mbRecordingId?: string;

  observationAudioUrl?: string;
  observationDurationMs?: number;
  observationGeneratedAt?: string;
  spotifyUrl: string;
  tiktokUrl?: string;
  title: string;
};

export function artistPageUrl(slug: string): string {
  return `${siteUrl}/artist/${slug}`;
}

function byArtistNode(
  name: string,
  artistSlugs: Record<string, string> | undefined,
): Record<string, unknown> {
  const slug = artistSlugs?.[fold(name)];

  return slug
    ? { "@id": artistPageUrl(slug), "@type": "MusicGroup", name }
    : { "@type": "MusicGroup", name };
}

function remixerContributorNodes(
  title: string,
  artists: string[],
  artistSlugs: Record<string, string> | undefined,
): Record<string, unknown>[] {
  return deriveRemixerNames(title, artists).map((name) => ({
    "@type": "Role",
    contributor: byArtistNode(name, artistSlugs),
    roleName: "remixer",
  }));
}

function measuredCompositionNode(track: {
  bpm?: number;
  key?: string;
  title: string;
}): Record<string, unknown> | undefined {
  if (!track.bpm && !track.key) {
    return undefined;
  }

  return {
    "@type": "MusicComposition",
    ...(track.bpm
      ? {
          additionalProperty: {
            "@type": "PropertyValue",
            name: "tempo",
            unitText: "BPM",
            value: Math.round(track.bpm),
          },
        }
      : {}),
    ...(track.key ? { musicalKey: track.key } : {}),
    name: track.title,
  };
}

export function musicRecordingJsonLd(
  track: LogSchemaInput,
  imageUrl: string,
): Record<string, unknown> {
  const recordingOf = measuredCompositionNode(track);
  const contributors = remixerContributorNodes(track.title, track.artists, track.artistSlugs);

  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    byArtist: track.artists.map((artist) => byArtistNode(artist, track.artistSlugs)),

    ...(contributors.length > 0 ? { contributor: contributors } : {}),
    datePublished: track.addedAt.slice(0, 10),
    description: definitionalProse(track),
    duration: formatIsoDuration(track.durationMs),
    genre: "Drum and Bass",

    identifier: [
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: track.logId },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: `fluncle://${track.logId}` },
      ...(track.mbRecordingId
        ? [
            {
              "@type": "PropertyValue",
              propertyID: "musicbrainz-recording-id",
              value: track.mbRecordingId,
            },
          ]
        : []),
    ],
    image: imageUrl,
    ...(track.isrc ? { isrcCode: track.isrc } : {}),
    ...(track.album ? { inAlbum: { "@type": "MusicAlbum", name: track.album } } : {}),
    name: track.title,

    ...(track.label && track.labelSlug
      ? {
          recordLabel: {
            "@id": `${labelPageUrl(track.labelSlug)}#organization`,
            "@type": "Organization",
            name: track.label,
            url: labelPageUrl(track.labelSlug),
          },
        }
      : {}),
    ...(recordingOf ? { recordingOf } : {}),
    sameAs: [
      track.spotifyUrl,
      ...(track.appleMusicUrl ? [track.appleMusicUrl] : []),
      ...(track.tiktokUrl ? [track.tiktokUrl] : []),
      ...(track.discogsReleaseUrl ? [track.discogsReleaseUrl] : []),

      ...(track.mbRecordingId ? [`https://musicbrainz.org/recording/${track.mbRecordingId}`] : []),
    ],
    url: logPageUrl(track.logId),
  };
}

export type GalaxyPlaylistFinding = {
  artists: string[];
  logId: string;
  title: string;
};

export function musicPlaylistJsonLd(
  galaxy: { name: string; slug: string },
  findings: GalaxyPlaylistFinding[],
): Record<string, unknown> {
  const galaxyUrl = `${siteUrl}/galaxies/${galaxy.slug}`;

  return {
    "@context": "https://schema.org",
    "@type": "MusicPlaylist",
    genre: "Drum and Bass",
    name: `${galaxy.name} · Fluncle's galaxies`,
    numTracks: findings.length,
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
    url: galaxyUrl,
  };
}

export function galaxyBreadcrumbsJsonLd(name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/galaxies`, name: "Galaxies", position: 2 },
      { "@type": "ListItem", name, position: 3 },
    ],
  };
}

function uploadDateIso(value: string): string {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

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

    creator: { "@id": fluncleEntityId },
    description: definitionalProse(track),
    name: artistTitleLine(track),
    publisher: { "@id": fluncleEntityId },
    thumbnailUrl,
    uploadDate: uploadDateIso(uploadDate),
    url: logPageUrl(track.logId),
  };
}

export function observationAudioObjectJsonLd(track: LogSchemaInput): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "AudioObject",
    contentUrl: track.observationAudioUrl,

    creator: { "@id": fluncleEntityId },
    description: definitionalProse(track),

    ...(track.observationDurationMs
      ? { duration: formatIsoDuration(track.observationDurationMs) }
      : {}),
    encodingFormat: "audio/mpeg",
    name: artistTitleLine(track),
    publisher: { "@id": fluncleEntityId },
    ...(track.observationGeneratedAt
      ? { uploadDate: uploadDateIso(track.observationGeneratedAt) }
      : {}),
    url: logPageUrl(track.logId),
  };
}

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
    creator: { "@id": fluncleEntityId },
    description: mixtape.note ?? `Fluncle drum & bass mixtape: ${mixtape.title}.`,
    name: mixtape.title,
    publisher: { "@id": fluncleEntityId },
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

    byArtist: { "@id": fluncleEntityId, "@type": "Person", name: "Fluncle" },
    ...(mixtape.recordedAt ? { datePublished: mixtape.recordedAt.slice(0, 10) } : {}),
    description: mixtape.note,
    duration: mixtape.durationMs ? formatIsoDuration(mixtape.durationMs) : undefined,
    genre: "Drum and Bass",
    identifier: [
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: logId },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: `fluncle://${logId}` },
    ],
    image: mixtape.coverImageUrl,
    name: mixtape.title,

    numTracks: mixtape.members.filter((member) => member.logId).length,
    publisher: { "@id": fluncleEntityId },
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

export type MusicGroupArtist = {
  alternateNames?: string[];

  bio?: string;

  discogsUrl?: string;
  imageUrl: string;

  lastfmUrl?: string;
  mbid?: string;
  name: string;
  slug: string;

  socials: string[];
  spotifyUrl?: string;
  wikidataQid?: string;
};

export type MusicGroupFinding = {
  artists: string[];
  logId: string;
  title: string;
};

function artistSameAs(artist: MusicGroupArtist): string[] {
  const ordered = [
    artist.wikidataQid ? `https://www.wikidata.org/wiki/${artist.wikidataQid}` : undefined,
    artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : undefined,
    artist.discogsUrl,
    artist.lastfmUrl,
    artist.spotifyUrl,
    ...artist.socials,
  ];

  return [...new Set(ordered.filter((url): url is string => Boolean(url)))];
}

export function musicGroupJsonLd(
  artist: MusicGroupArtist,
  findings: MusicGroupFinding[],
): Record<string, unknown> {
  const artistUrl = artistPageUrl(artist.slug);
  const sameAs = artistSameAs(artist);
  const alternateNames = artist.alternateNames ?? [];

  const artistSlugs: Record<string, string> = { [fold(artist.name)]: artist.slug };

  return {
    "@context": "https://schema.org",
    "@id": artistUrl,
    "@type": "MusicGroup",

    ...(alternateNames.length > 0
      ? { alternateName: alternateNames.length === 1 ? alternateNames[0] : alternateNames }
      : {}),

    ...(artist.bio ? { description: artist.bio } : {}),
    genre: "Drum and Bass",
    image: artist.imageUrl,
    name: artist.name,
    ...(sameAs.length > 0 ? { sameAs } : {}),

    ...(findings.length > 0
      ? {
          track: {
            "@type": "ItemList",
            itemListElement: findings.reduce<
              Array<{
                "@type": "ListItem";
                item: {
                  "@type": "MusicRecording";
                  byArtist: Array<Record<string, unknown>>;
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
                  byArtist: finding.artists.map((name) => byArtistNode(name, artistSlugs)),
                  name: finding.title,
                  url: logPageUrl(finding.logId),
                },
                position: items.length + 1,
              });

              return items;
            }, []),
          },
        }
      : {}),
    url: artistUrl,
  };
}

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

export function labelPageUrl(slug: string): string {
  return `${siteUrl}/label/${slug}`;
}

export function albumPageUrl(slug: string): string {
  return `${siteUrl}/album/${slug}`;
}

export type GraphPageTrack = {
  artists: string[];

  durationMs?: number;

  isrc?: string;

  logId?: string;

  releaseDate?: string;

  spotifyUrl?: string;
  title: string;

  trackId?: string;
};

function trackItemList(
  tracks: GraphPageTrack[],
  artistSlugs: Record<string, string>,
): Record<string, unknown> {
  return {
    "@type": "ItemList",
    itemListElement: tracks.map((track, index) => {
      const url = track.logId
        ? logPageUrl(track.logId)
        : track.trackId
          ? trackPageUrl(track.trackId)
          : track.spotifyUrl;
      const contributors = remixerContributorNodes(track.title, track.artists, artistSlugs);

      return {
        "@type": "ListItem",
        item: {
          "@type": "MusicRecording",
          byArtist: track.artists.map((name) => byArtistNode(name, artistSlugs)),

          ...(contributors.length > 0 ? { contributor: contributors } : {}),

          ...(track.durationMs ? { duration: formatIsoDuration(track.durationMs) } : {}),
          ...(track.isrc ? { isrcCode: track.isrc } : {}),
          name: track.title,
          ...(track.releaseDate ? { datePublished: track.releaseDate } : {}),
          ...(url ? { url } : {}),
        },
        position: index + 1,
      };
    }),
  };
}

function foldArtistSlugs(artists: { name: string; slug: string }[]): Record<string, string> {
  const slugs: Record<string, string> = {};

  for (const artist of artists) {
    slugs[fold(artist.name)] = artist.slug;
  }

  return slugs;
}

export type RecordLabelInput = {
  alternateNames?: string[];
  artists: { name: string; slug: string }[];

  bio?: string;

  discogsLabelId?: number;

  foundingDate?: string;

  location?: string;

  logoImageUrl?: string;

  mbLabelId?: string;
  name: string;

  parentOrganization?: { name: string; slug: string };
  slug: string;

  subOrganizations?: { name: string; slug: string }[];
  tracks: GraphPageTrack[];
};

function labelOrganizationEdge(edge: { name: string; slug: string }): Record<string, unknown> {
  const url = labelPageUrl(edge.slug);

  return { "@id": `${url}#organization`, "@type": "Organization", name: edge.name, url };
}

function labelOrganizationSameAs(label: RecordLabelInput): string[] {
  const anchors = [
    label.mbLabelId ? `https://musicbrainz.org/label/${label.mbLabelId}` : undefined,
    typeof label.discogsLabelId === "number"
      ? `https://www.discogs.com/label/${label.discogsLabelId}`
      : undefined,
  ];

  return anchors.filter((url): url is string => Boolean(url));
}

export function recordLabelJsonLd(label: RecordLabelInput): Record<string, unknown> {
  const pageUrl = labelPageUrl(label.slug);
  const alternateNames = label.alternateNames ?? [];
  const sameAs = labelOrganizationSameAs(label);
  const subOrganizations = label.subOrganizations ?? [];

  return {
    "@context": "https://schema.org",
    "@id": pageUrl,
    "@type": "CollectionPage",
    about: {
      "@id": `${pageUrl}#organization`,
      "@type": "Organization",

      ...(alternateNames.length > 0
        ? { alternateName: alternateNames.length === 1 ? alternateNames[0] : alternateNames }
        : {}),

      ...(label.bio ? { description: label.bio } : {}),

      ...(label.foundingDate ? { foundingDate: label.foundingDate } : {}),
      ...(label.location ? { location: { "@type": "Place", name: label.location } } : {}),

      ...(label.logoImageUrl ? { logo: label.logoImageUrl } : {}),
      name: label.name,

      ...(label.parentOrganization
        ? { parentOrganization: labelOrganizationEdge(label.parentOrganization) }
        : {}),

      ...(sameAs.length > 0 ? { sameAs } : {}),
      ...(subOrganizations.length > 0
        ? { subOrganization: subOrganizations.map(labelOrganizationEdge) }
        : {}),
      url: pageUrl,
    },
    mainEntity: trackItemList(label.tracks, foldArtistSlugs(label.artists)),
    name: label.name,
    url: pageUrl,
  };
}

export type MusicAlbumInput = {
  artists: { name: string; slug: string }[];

  bio?: string;

  catalogNumber?: string;
  imageUrl?: string;

  label?: { name: string; slug: string };
  name: string;
  releaseDate?: string;

  releaseGroupMbid?: string;
  slug: string;
  tracks: GraphPageTrack[];

  upc?: string;
};

export function musicAlbumJsonLd(album: MusicAlbumInput): Record<string, unknown> {
  const pageUrl = albumPageUrl(album.slug);
  const labelUrl = album.label ? labelPageUrl(album.label.slug) : undefined;

  return {
    "@context": "https://schema.org",
    "@id": pageUrl,
    "@type": "MusicAlbum",

    ...(album.label && labelUrl
      ? {
          albumRelease: {
            "@type": "MusicRelease",
            ...(album.catalogNumber ? { catalogNumber: album.catalogNumber } : {}),
            name: album.name,
            recordLabel: {
              "@id": `${labelUrl}#organization`,
              "@type": "Organization",
              name: album.label.name,
              url: labelUrl,
            },
          },
        }
      : album.catalogNumber
        ? {
            albumRelease: {
              "@type": "MusicRelease",
              catalogNumber: album.catalogNumber,
              name: album.name,
            },
          }
        : {}),

    ...(album.artists.length > 0
      ? {
          byArtist: album.artists.map((artist) => ({
            "@id": artistPageUrl(artist.slug),
            "@type": "MusicGroup",
            name: artist.name,
          })),
        }
      : {}),

    ...(album.bio ? { description: album.bio } : {}),
    genre: "Drum and Bass",

    ...(album.upc ? { gtin13: album.upc } : {}),
    ...(album.imageUrl ? { image: album.imageUrl } : {}),
    name: album.name,
    ...(album.releaseDate ? { datePublished: album.releaseDate } : {}),

    ...(album.releaseGroupMbid
      ? { sameAs: [`https://musicbrainz.org/release-group/${album.releaseGroupMbid}`] }
      : {}),
    track: trackItemList(album.tracks, foldArtistSlugs(album.artists)),
    url: pageUrl,
  };
}

export function labelBreadcrumbsJsonLd(name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/labels`, name: "Labels", position: 2 },
      { "@type": "ListItem", name, position: 3 },
    ],
  };
}

export function archiveTrackJsonLd(track: ArchiveTrackSchemaInput): Record<string, unknown> {
  const recordingOf = measuredCompositionNode(track);
  const sameAs = [
    ...track.listenUrls,
    ...(track.discogsReleaseUrl ? [track.discogsReleaseUrl] : []),
    ...(track.mbRecordingId ? [`https://musicbrainz.org/recording/${track.mbRecordingId}`] : []),
  ];
  const identifier = track.mbRecordingId
    ? [
        {
          "@type": "PropertyValue",
          propertyID: "musicbrainz-recording-id",
          value: track.mbRecordingId,
        },
      ]
    : [];

  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    byArtist: track.artists.map((artist) => byArtistNode(artist, track.artistSlugs)),
    ...(track.releaseDate ? { datePublished: track.releaseDate } : {}),

    ...(track.durationMs ? { duration: formatIsoDuration(track.durationMs) } : {}),
    genre: "Drum and Bass",
    ...(identifier.length > 0 ? { identifier } : {}),
    ...(track.imageUrl ? { image: track.imageUrl } : {}),

    ...(track.album
      ? {
          inAlbum: track.album.slug
            ? {
                "@id": albumPageUrl(track.album.slug),
                "@type": "MusicAlbum",
                name: track.album.name,
                url: albumPageUrl(track.album.slug),
              }
            : { "@type": "MusicAlbum", name: track.album.name },
        }
      : {}),
    ...(track.isrc ? { isrcCode: track.isrc } : {}),
    name: track.title,
    ...(track.label?.slug
      ? {
          recordLabel: {
            "@id": `${labelPageUrl(track.label.slug)}#organization`,
            "@type": "Organization",
            name: track.label.name,
            url: labelPageUrl(track.label.slug),
          },
        }
      : track.label
        ? { recordLabel: { "@type": "Organization", name: track.label.name } }
        : {}),
    ...(recordingOf ? { recordingOf } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    url: trackPageUrl(track.trackId),
  };
}

export type ArchiveTrackSchemaInput = {
  album?: { name: string; slug?: string };
  artistSlugs?: Record<string, string>;
  artists: string[];
  bpm?: number;
  discogsReleaseUrl?: string;

  durationMs?: number;
  imageUrl?: string;
  isrc?: string;
  key?: string;
  label?: { name: string; slug?: string };

  listenUrls: string[];
  mbRecordingId?: string;
  releaseDate?: string;
  title: string;
  trackId: string;
};

export function trackBreadcrumbsJsonLd(name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/tracks`, name: "Tracks", position: 2 },
      { "@type": "ListItem", name, position: 3 },
    ],
  };
}

export function albumBreadcrumbsJsonLd(name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/albums`, name: "Albums", position: 2 },
      { "@type": "ListItem", name, position: 3 },
    ],
  };
}

export function logbookBreadcrumbsJsonLd(sectorLabel: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/logbook`, name: "Logbook", position: 2 },
      { "@type": "ListItem", name: sectorLabel, position: 3 },
    ],
  };
}

export function docsBreadcrumbsJsonLd(title: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/docs`, name: "Docs", position: 2 },
      { "@type": "ListItem", name: title, position: 3 },
    ],
  };
}

export function newsletterBreadcrumbsJsonLd(number: number): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/newsletter`, name: "Newsletter", position: 2 },
      { "@type": "ListItem", name: `#${number}`, position: 3 },
    ],
  };
}
