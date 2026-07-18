import { fluncleEntityId, logPageUrl, siteUrl } from "./fluncle-links";
import { formatIsoDuration } from "./format";
import { artistTitleLine, definitionalProse, type LogProseInput } from "./log-prose";
import { type MixtapeDTO } from "./mixtapes";
import { fold } from "./server/track-match";

// Re-exported for callers that have always reached the log-URL builder through
// the log schema; the canonical definition now lives in fluncle-links.
export { logPageUrl };

// The log page's JSON-LD, pure: the route's head() reads from here, and the
// schema's description is the SAME string as the visible definitional block
// (schema that contradicts the page gets discounted).

export type LogSchemaInput = LogProseInput & {
  album?: string;
  albumImageUrl?: string;
  // The finding's Apple Music URL — a per-track `sameAs` (the Spotify twin). Present
  // only when the exact-ISRC resolve landed one.
  appleMusicUrl?: string;
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
  // The MusicBrainz recording MBID (the KG join key). Present ⇒ the MusicRecording gains a
  // `https://musicbrainz.org/recording/<mbid>` `sameAs` + a `musicbrainz-recording-id`
  // `identifier` PropertyValue. Absent until a fill path lands it (the honest degrade).
  mbRecordingId?: string;
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
// page's own `@id` (the cross-page graph). The lookup is on the NORMALIZED name
// (`fold`), matching how the slug map is keyed, so a casing/accent/`feat.` drift
// between the display name and the canonical `artists.name` still stamps the `@id`.
function byArtistNode(
  name: string,
  artistSlugs: Record<string, string> | undefined,
): Record<string, unknown> {
  const slug = artistSlugs?.[fold(name)];

  return slug
    ? { "@id": artistPageUrl(slug), "@type": "MusicGroup", name }
    : { "@type": "MusicGroup", name };
}

/**
 * The finding's MEASURED tempo + key, modelled as the composition this recording is
 * of (`recordingOf` → `MusicComposition`, both native schema.org). Fluncle measures
 * both first-party — DSP over the captured full song, graded by the operator's
 * Rekordbox — so with Spotify's audio-features API dead (Nov 2024) this is the live,
 * citable source for a track's tempo and key.
 *
 * - KEY rides `musicalKey`, the property schema.org defines specifically for this on
 *   MusicComposition (range Text, "The key, mode, or scale this composition uses").
 * - TEMPO has NO native schema.org property anywhere, so it rides an
 *   `additionalProperty` `PropertyValue` (name "tempo", unitText "BPM") — schema.org's
 *   sanctioned slot for "a characteristic for which there is no matching property".
 *
 * Emitted per-value: tempo ONLY when `bpm` is present, key ONLY when `key` is present.
 * A NULL key is below the DSP confidence floor — say nothing, never a guessed value.
 * The whole node is omitted when the finding carries neither. Additive to the
 * MusicRecording — it does not alter the recording's own Rich-Results shape.
 */
function measuredCompositionNode(track: LogSchemaInput): Record<string, unknown> | undefined {
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

  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    byArtist: track.artists.map((artist) => byArtistNode(artist, track.artistSlugs)),
    datePublished: track.addedAt.slice(0, 10),
    description: definitionalProse(track),
    duration: formatIsoDuration(track.durationMs),
    genre: "Drum and Bass",
    // The Log ID in BOTH forms as identifiers (not alternateName): the bare
    // coordinate and the fluncle:// URI are the retrieval tokens. The MusicBrainz recording MBID
    // joins the list only when present — the canonical KG anchor a crawler reconciles this
    // recording to MusicBrainz + Wikidata by (the MusicBrainz identity layer).
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
    // The recording → label edge, closing the same loop the album schema's `recordLabel`
    // already closes: point at the label page's Organization `@id` (`<labelPageUrl>#organization`)
    // so a crawler reconciles this recording, its album, and its imprint to one graph. Emitted
    // only when the finding carries a label WITH a resolved `/label/<slug>` entity — a bare label
    // string with no page has no `@id` to point at, so it stays silent (the honest degrade).
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
      // The MusicBrainz recording page — the canonical KG anchor (present only once filled).
      ...(track.mbRecordingId ? [`https://musicbrainz.org/recording/${track.mbRecordingId}`] : []),
    ],
    url: logPageUrl(track.logId),
  };
}

/** One finding in a galaxy's playlist — a MusicRecording reference by its /log URL. */
export type GalaxyPlaylistFinding = {
  artists: string[];
  logId: string;
  title: string;
};

/**
 * A sonic galaxy's JSON-LD (browse-by-feel RFC): a `MusicPlaylist` whose members are
 * `MusicRecording` references by `/log/<logId>` URL, in the page's core-first order
 * (`numTracks` is the members shown). The honest shape for "a set of recordings grouped
 * by sound" — reuses the same `byArtist`/reducer shape as `mixtapeAlbumJsonLd`, so a
 * galaxy reads to a crawler exactly like a mixtape's tracklist does.
 */
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

/** Fluncle → Galaxies → the galaxy name, the galaxy page's breadcrumb. */
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
    // The video is Fluncle's own artefact — reference the ONE canonical entity node as both
    // its creator and publisher, so the video reconciles to the same `@id` as the finding.
    creator: { "@id": fluncleEntityId },
    description: definitionalProse(track),
    name: artistTitleLine(track),
    publisher: { "@id": fluncleEntityId },
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
    // The mix is by — and published by — the ONE canonical entity node (`@id`), never a second
    // dangling `/about` Person that reads as a different thing to a crawler.
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
    // The renderable member count — the findings the tracklist actually resolves to a `/log`
    // coordinate (a member without one is dropped from the ItemList below), so `numTracks`
    // matches what the structured data carries.
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

/** The artist page's identity + its confirmed off-site anchors, for `sameAs`. */
export type MusicGroupArtist = {
  /**
   * The artist's PUBLIC alternate names (the MusicBrainz identity layer, the label page's
   * `alternateNames` twin) — the trusted `auto`/`confirmed`, `kind='name'` aliases the resolve
   * pipeline harvested from MusicBrainz. Emitted as the MusicGroup's `alternateName`. Absent/empty
   * ⇒ the key is omitted.
   */
  alternateNames?: string[];
  /**
   * The artist's factual bio, when one is authored — the SAME paragraph the page prints. Emitted
   * as the MusicGroup's `description` (schema description mirrors the visible definitional
   * content). Undefined until the bio is backfilled ⇒ the key is omitted, never `description:
   * null`.
   */
  bio?: string;
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
  const alternateNames = artist.alternateNames ?? [];
  // The page's OWN artist name → slug, folded to match `byArtistNode`'s lookup.
  // Every finding on this page credits this artist, so stamping the nested
  // `byArtist` nodes reconciles each recording back to the artist's `@id` for
  // free — the same graph anchor the top-level MusicGroup + the `/log` byArtist
  // nodes carry (Unit 3, artist-relationship RFC §3).
  const artistSlugs: Record<string, string> = { [fold(artist.name)]: artist.slug };

  return {
    "@context": "https://schema.org",
    "@id": artistUrl,
    "@type": "MusicGroup",
    // The artist's other recorded names (the MusicBrainz identity layer) — one string collapses to
    // a scalar, several to an array (both valid schema.org), omitted entirely otherwise, so an
    // artist without aliases is byte-identical to before. Mirrors the label page's alternateName.
    ...(alternateNames.length > 0
      ? { alternateName: alternateNames.length === 1 ? alternateNames[0] : alternateNames }
      : {}),
    // The factual bio mirrors the page's visible definitional paragraph — omitted cleanly (never
    // `description: null`) until one is authored.
    ...(artist.bio ? { description: artist.bio } : {}),
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

// ── The graph pages: labels + albums ────────────────────────────────────────────────
//
// The two nodes that complete `log ↔ artist ↔ label ↔ album`. Their JSON-LD follows the
// artist page's shape — an `@id`-bearing entity node whose `@id` IS the page URL, so a
// crawler reconciles every mention of the entity across the site to one thing — and their
// track lists carry BOTH halves of the page: the findings (which link to their `/log`
// coordinate) and the quieter rows (which have no Fluncle page and carry their off-site
// URL instead, or none at all).
//
// That is honest structured data — these really are tracks on this record / this imprint —
// and it never claims a certification that does not exist: only a finding gets a
// `fluncle.com/log/...` url. Schema that contradicts the page gets discounted; schema that
// matches it is what puts the page in an AI answer.

/** The `<siteUrl>/label/<slug>` node id. */
export function labelPageUrl(slug: string): string {
  return `${siteUrl}/label/${slug}`;
}

/** The `<siteUrl>/album/<slug>` node id. */
export function albumPageUrl(slug: string): string {
  return `${siteUrl}/album/${slug}`;
}

/** One track on a graph page: a finding (with a Log ID) or a quieter uncertified row. */
export type GraphPageTrack = {
  artists: string[];
  /** The finding's length in ms → the MusicRecording's ISO-8601 `duration`. Findings only. */
  durationMs?: number;
  /** The finding's ISRC → the MusicRecording's `isrcCode`. Findings only. */
  isrc?: string;
  /** Present ⇒ a finding: the item's `url` is its `/log` page. */
  logId?: string;
  /** The finding's release date → the MusicRecording's `datePublished`. Findings only. */
  releaseDate?: string;
  /** The off-site URL for a track with no Fluncle page. Absent ⇒ the item carries no url. */
  spotifyUrl?: string;
  title: string;
};

// A track list as schema.org `ItemList` of `MusicRecording`s. A finding resolves to its
// `/log/<id>` page; an uncertified row resolves to its off-site URL, or to no url at all
// (a catalogue-only track may have no Spotify presence). `artistSlugs` stamps each credited
// artist's `@id` where the entity is known — the same cross-page anchor `/log` and
// `/artist` already carry.
function trackItemList(
  tracks: GraphPageTrack[],
  artistSlugs: Record<string, string>,
): Record<string, unknown> {
  return {
    "@type": "ItemList",
    itemListElement: tracks.map((track, index) => {
      const url = track.logId ? logPageUrl(track.logId) : track.spotifyUrl;

      return {
        "@type": "ListItem",
        item: {
          "@type": "MusicRecording",
          byArtist: track.artists.map((name) => byArtistNode(name, artistSlugs)),
          // The finding's per-track facts (G1): its ISO-8601 length, its ISRC, and its release
          // date. Present on findings only — a quieter catalogue row carries none of them, so
          // the keys are omitted rather than emitted null (schema that contradicts the page gets
          // discounted; an uncertified row stays as spare as it renders).
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

/** The label/album page's artist entities, folded for `byArtistNode`'s lookup. */
function foldArtistSlugs(artists: { name: string; slug: string }[]): Record<string, string> {
  const slugs: Record<string, string> = {};

  for (const artist of artists) {
    slugs[fold(artist.name)] = artist.slug;
  }

  return slugs;
}

/** The label page's identity + the page's contents. */
export type RecordLabelInput = {
  /**
   * The label's CONFIRMED alternate spellings (RFC musickit-second-authority, U2a, decision C).
   * A second authority (Apple, corroborated by MusicBrainz) proposed them and the operator ruled
   * them the same label; `candidate`/`hint` aliases never reach here. Emitted as the
   * Organization's `alternateName`. Absent/empty ⇒ the key is omitted.
   */
  alternateNames?: string[];
  artists: { name: string; slug: string }[];
  /**
   * The label's factual bio, when one is authored — the SAME paragraph the page prints. Emitted
   * as the Organization's `description` (schema description mirrors the visible definitional
   * content — and the bio describes the label entity, so it rides the Organization node, not the
   * CollectionPage). Undefined until backfilled ⇒ the key is omitted, never `description: null`.
   */
  bio?: string;
  /**
   * The Discogs label id (`labels.discogs_label_id`) — an off-site identity anchor. Emitted into
   * the Organization's `sameAs` as `https://www.discogs.com/label/<id>`. Absent ⇒ omitted.
   */
  discogsLabelId?: number;
  /**
   * The label's OWN logo (its resolved image on R2, `labels.image_key` → a served URL), emitted as
   * the Organization's `logo`. Currently only powers the page's OG image; here it becomes part of
   * the entity itself. Absent ⇒ omitted.
   */
  logoImageUrl?: string;
  /**
   * The MusicBrainz label MBID (`labels.mb_label_id`) — an off-site identity anchor. Emitted into
   * the Organization's `sameAs` as `https://musicbrainz.org/label/<mbid>`. Absent ⇒ omitted.
   */
  mbLabelId?: string;
  name: string;
  slug: string;
  tracks: GraphPageTrack[];
};

/** The label Organization's off-site identity anchors → its `sameAs` (MusicBrainz, then Discogs). */
function labelOrganizationSameAs(label: RecordLabelInput): string[] {
  const anchors = [
    label.mbLabelId ? `https://musicbrainz.org/label/${label.mbLabelId}` : undefined,
    typeof label.discogsLabelId === "number"
      ? `https://www.discogs.com/label/${label.discogsLabelId}`
      : undefined,
  ];

  return anchors.filter((url): url is string => Boolean(url));
}

/**
 * The label page's JSON-LD: a `CollectionPage` ABOUT an `Organization` (schema.org has no
 * record-label type; a label is an organization, never a `MusicGroup` — it is not a band),
 * carrying the page's tracks as its `mainEntity` list. The Organization's `@id` is the
 * page URL, so the `recordLabel` node an album page emits points straight back here.
 *
 * When the label carries CONFIRMED aliases, the Organization gets an `alternateName` — the two
 * spellings the operator ruled one label, so a crawler that knows the imprint under either name
 * lands on the same entity (decision C).
 */
export function recordLabelJsonLd(label: RecordLabelInput): Record<string, unknown> {
  const pageUrl = labelPageUrl(label.slug);
  const alternateNames = label.alternateNames ?? [];
  const sameAs = labelOrganizationSameAs(label);

  return {
    "@context": "https://schema.org",
    "@id": pageUrl,
    "@type": "CollectionPage",
    about: {
      "@id": `${pageUrl}#organization`,
      "@type": "Organization",
      // Only when confirmed aliases exist: one string collapses to a scalar, several to an array
      // (both valid schema.org). Omitted entirely otherwise, so a label without aliases is byte-
      // identical to before.
      ...(alternateNames.length > 0
        ? { alternateName: alternateNames.length === 1 ? alternateNames[0] : alternateNames }
        : {}),
      // The factual bio mirrors the page's visible definitional paragraph — omitted cleanly
      // (never `description: null`) until one is authored.
      ...(label.bio ? { description: label.bio } : {}),
      // The label's OWN logo (its resolved R2 image) as the Organization's `logo` — it was only an
      // OG image before; here it becomes part of the entity a crawler reads. Omitted when unresolved.
      ...(label.logoImageUrl ? { logo: label.logoImageUrl } : {}),
      name: label.name,
      // The off-site identity anchors (MusicBrainz, Discogs) — the label's `sameAs`, the imprint
      // twin of the artist entity's identity graph. Omitted entirely when the label carries none.
      ...(sameAs.length > 0 ? { sameAs } : {}),
      url: pageUrl,
    },
    mainEntity: trackItemList(label.tracks, foldArtistSlugs(label.artists)),
    name: label.name,
    url: pageUrl,
  };
}

/** The album page's identity + the page's contents. */
export type MusicAlbumInput = {
  artists: { name: string; slug: string }[];
  /**
   * The album's factual bio, when one is authored — the SAME paragraph the page prints. Emitted
   * as the MusicAlbum's `description` (schema description mirrors the visible definitional
   * content). Undefined until backfilled ⇒ the key is omitted, never `description: null`.
   */
  bio?: string;
  imageUrl?: string;
  /** The album's label, when one of its tracks carried one — the album → label graph edge. */
  label?: { name: string; slug: string };
  name: string;
  releaseDate?: string;
  /**
   * The MusicBrainz release-group MBID (`albums.release_group_mbid`) — the album's off-site
   * identity anchor. Emitted into `sameAs` as `https://musicbrainz.org/release-group/<mbid>`.
   * Absent ⇒ omitted.
   */
  releaseGroupMbid?: string;
  slug: string;
  tracks: GraphPageTrack[];
  /** The album's barcode (`albums.upc`) → the MusicAlbum's `gtin13`. Absent ⇒ omitted. */
  upc?: string;
};

/**
 * The album page's JSON-LD: a real `MusicAlbum` — `byArtist` (the credited entities),
 * `track` (the ItemList), and, where the album's label is known, an `albumRelease` →
 * `MusicRelease.recordLabel` pointing at the label page's Organization `@id`. That last
 * edge is the whole reason both pages exist in one PR: the graph closes.
 */
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
            name: album.name,
            recordLabel: {
              "@id": `${labelUrl}#organization`,
              "@type": "Organization",
              name: album.label.name,
              url: labelUrl,
            },
          },
        }
      : {}),
    byArtist: album.artists.map((artist) => ({
      "@id": artistPageUrl(artist.slug),
      "@type": "MusicGroup",
      name: artist.name,
    })),
    // The factual bio mirrors the page's visible definitional paragraph — omitted cleanly
    // (never `description: null`) until one is authored.
    ...(album.bio ? { description: album.bio } : {}),
    genre: "Drum and Bass",
    // The album's barcode as `gtin13` — schema.org's global-trade identity for a release.
    ...(album.upc ? { gtin13: album.upc } : {}),
    ...(album.imageUrl ? { image: album.imageUrl } : {}),
    name: album.name,
    ...(album.releaseDate ? { datePublished: album.releaseDate } : {}),
    // The off-site identity anchor: the MusicBrainz release group (the album abstraction over its
    // pressings). Omitted when the album carries no release-group MBID.
    ...(album.releaseGroupMbid
      ? { sameAs: [`https://musicbrainz.org/release-group/${album.releaseGroupMbid}`] }
      : {}),
    track: trackItemList(album.tracks, foldArtistSlugs(album.artists)),
    url: pageUrl,
  };
}

/** Fluncle → Labels → the label name. */
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

/** Fluncle → Albums → the album name. */
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
