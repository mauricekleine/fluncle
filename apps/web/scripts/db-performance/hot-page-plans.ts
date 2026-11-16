import { albumCoverUrl, getAlbumBySlug } from "../../src/lib/server/albums";
import {
  getPublicArtistBySlug,
  listArtistsByAlbum,
  listArtistsByLabel,
} from "../../src/lib/server/artists";
import {
  listArtistCatalogue,
  listArtistUpcoming,
  listLabelCatalogue,
  listLabelUpcoming,
} from "../../src/lib/server/catalogue-groups";
import { getLabelBySlug, getLabelForAlbum } from "../../src/lib/server/labels";
import { readTrackDestination } from "../../src/lib/server/track-page";
import {
  getFindingsByArtist,
  getFindingsByAlbum,
  getFindingsByLabel,
  listCatalogueTracksByArtist,
  listCatalogueTracksByAlbum,
  listRelatedFindings,
  type RelatedFindingsScope,
} from "../../src/lib/server/tracks";
import { type ExplainPlanPolicy } from "./plan";
import { PerformanceRegistry, type PerformanceStatement, sqlContract } from "./registry";

const TODAY = "2026-11-15";
const TRACK = "synthetic-track";
const ARTIST = "synthetic-artist";
const ALBUM = "synthetic-album";
const LABEL = "synthetic-label";

type Access = NonNullable<ExplainPlanPolicy["accessPaths"]>[number];
const path = (index: string, ...equalityPrefix: string[]) => ({ equalityPrefix, index });
const seek = (table: string, paths: Access["paths"], minimumSearches = 1): Access => ({
  minimumSearches,
  paths,
  table,
});
const pk = (table: string, entity = table, key = "id") =>
  seek(table, [path(`sqlite_autoindex_${entity}_1`, key)]);
const trackPk = seek("tracks", [
  path("sqlite_autoindex_tracks_1", "track_id"),
  path("tracks_catalogue_active_track_id_idx", "is_catalogue", "dismissed_at", "track_id"),
]);
const albumTracks = [path("tracks_album_id_idx", "album_id")];
const labelTracks = [
  path("tracks_label_id_idx", "label_id"),
  path("tracks_label_cover_idx", "label_id"),
];
const creditTrack = [
  path("track_artists_track_id_idx", "track_id"),
  path("sqlite_autoindex_track_artists_1", "track_id"),
];
const artistCredit = (table: string) =>
  seek(table, [path("track_artists_artist_id_idx", "artist_id")]);
const growingTables = [
  "tracks",
  "track_artists",
  "findings",
  "albums",
  "artists",
  "labels",
  "t",
  "t2",
  "ct",
  "lt",
  "ta",
  "ca",
  "la",
  "fa",
  "edge",
  "a",
  "al",
  "seed_ta",
  "seed_a",
  "seed_ac",
  "unlisted_rule",
  "unlisted_artist",
  "s",
  "f",
];

function policy(...accessPaths: Access[]): ExplainPlanPolicy {
  return { accessPaths, growingTables };
}

type HotPageRead = {
  id: string;
  policy: ExplainPlanPolicy;
  read: () => Promise<unknown>;
};

const membership = [
  artistCredit("ta"),
  seek("edge", creditTrack),
  seek("t", [
    path("sqlite_autoindex_tracks_1", "track_id"),
    path("tracks_release_date_track_id_idx"),
  ]),
];
const findingsDriver: ExplainPlanPolicy = { allowFullScanOf: ["findings"] };
const optionalFindingSeek = { ...pk("findings", "findings", "track_id"), minimumSearches: 0 };
const entityHydration = [pk("al", "albums"), pk("findings", "findings", "track_id")];
const relatedScopes: RelatedFindingsScope[] = [
  { kind: "track", trackId: TRACK },
  { artistId: ARTIST, kind: "artist" },
  { albumId: ALBUM, kind: "album" },
  { kind: "label", labelId: LABEL },
];

export const hotPageReads: readonly HotPageRead[] = [
  {
    id: "track.destination",
    policy: policy(
      trackPk,
      pk("findings", "findings", "track_id"),
      pk("albums"),
      pk("labels"),
      seek("ta", creditTrack),
      pk("a", "artists"),
    ),
    read: () => readTrackDestination(TRACK),
  },
  ...[undefined, ALBUM].map((excludeAlbumId): HotPageRead => ({
    id: `track.artist-band.${excludeAlbumId ? "exclude-record" : "all"}`,
    policy: policy({ ...trackPk, minimumSearches: 2 }, artistCredit("track_artists"), pk("albums")),
    read: () => listCatalogueTracksByArtist(ARTIST, { excludeAlbumId, limit: 48, today: TODAY }),
  })),
  {
    id: "track.record-band",
    policy: policy(
      seek("tracks", albumTracks),
      pk("findings", "findings", "track_id"),
      pk("albums"),
    ),
    read: () => listCatalogueTracksByAlbum(ALBUM),
  },
  ...relatedScopes.map((scope): HotPageRead => {
    const scopeAccess: Access[] =
      scope.kind === "track"
        ? [pk("ct", "tracks", "track_id"), seek("ca", creditTrack)]
        : scope.kind === "artist"
          ? [
              pk("ct", "tracks", "track_id"),
              artistCredit("ca"),
              pk("s", "artist_similar", "artist_id"),
            ]
          : scope.kind === "album"
            ? [seek("ct", albumTracks), seek("ca", creditTrack)]
            : [seek("lt", labelTracks), seek("la", creditTrack)];
    return {
      id: `related.${scope.kind}`,
      policy: {
        ...policy(
          { ...trackPk, minimumSearches: 2 },
          seek("fa", creditTrack),
          ...scopeAccess,
          pk("albums"),
          seek("seed_ta", creditTrack),
          pk("seed_a", "artists"),
          pk("seed_ac", "artist_centroids", "artist_id"),
        ),
        allowFullScanOf: ["findings"],
      },
      read: () =>
        listRelatedFindings(scope, {
          excludeTrackIds: [TRACK],
          limit: scope.kind === "track" ? 12 : 4,
          today: TODAY,
        }),
    };
  }),
  ...(["name", "recent"] as const).flatMap((sort): HotPageRead[] => [
    {
      id: `artist.catalogue.${sort}`,
      policy: policy(trackPk, artistCredit("ta"), ...entityHydration),
      read: () => listArtistCatalogue(ARTIST, sort, 1, TODAY),
    },
    {
      id: `label.catalogue.${sort}`,
      policy: policy(seek("tracks", labelTracks, 3), ...entityHydration),
      read: () => listLabelCatalogue(LABEL, sort, 1, TODAY),
    },
  ]),
  {
    id: "artist.findings",
    policy: { ...policy(trackPk, ...membership, optionalFindingSeek), ...findingsDriver },
    read: () => getFindingsByArtist(ARTIST, "Synthetic Artist", TODAY),
  },
  {
    id: "artist.upcoming",
    policy: policy(trackPk, ...membership, pk("findings", "findings", "track_id")),
    read: () => listArtistUpcoming(ARTIST, TODAY),
  },
  {
    id: "label.upcoming",
    policy: policy(
      seek("tracks", [...labelTracks, path("sqlite_autoindex_tracks_1", "track_id")]),
      pk("findings", "findings", "track_id"),
    ),
    read: () => listLabelUpcoming(LABEL, TODAY),
  },
  {
    id: "album.findings",
    policy: {
      ...policy(seek("tracks", [...albumTracks, ...trackPk.paths]), optionalFindingSeek),
      ...findingsDriver,
    },
    read: () => getFindingsByAlbum(ALBUM),
  },
  {
    id: "label.findings",
    policy: {
      ...policy(seek("tracks", [...labelTracks, ...trackPk.paths]), optionalFindingSeek),
      ...findingsDriver,
    },
    read: () => getFindingsByLabel(LABEL, TODAY),
  },
  {
    id: "album.artists",
    policy: policy(seek("tracks", albumTracks), seek("ta", creditTrack), pk("a", "artists")),
    read: () => listArtistsByAlbum(ALBUM),
  },
  {
    id: "label.artists",
    policy: policy(seek("tracks", labelTracks), seek("ta", creditTrack), pk("a", "artists")),
    read: () => listArtistsByLabel(LABEL),
  },
  {
    id: "album.label",
    policy: policy(seek("tracks", albumTracks), pk("labels")),
    read: () => getLabelForAlbum(ALBUM),
  },
  {
    id: "album.detail",
    policy: policy(seek("albums", [path("albums_slug_unique", "slug")]), seek("t", albumTracks)),
    read: () => getAlbumBySlug(ALBUM),
  },
  {
    id: "album.cover",
    policy: policy(pk("albums"), seek("t2", albumTracks)),
    read: () => albumCoverUrl(ALBUM),
  },
  {
    id: "artist.detail",
    policy: policy(seek("artists", [path("artists_slug_unique", "slug")])),
    read: () => getPublicArtistBySlug(ARTIST),
  },
  {
    id: "label.detail",
    policy: policy(seek("labels", [path("labels_slug_unique", "slug")])),
    read: () => getLabelBySlug(LABEL),
  },
];

export async function hotPagePlanRegistry(
  capture: (read: () => Promise<unknown>) => Promise<PerformanceStatement[]>,
): Promise<PerformanceRegistry> {
  const registry = new PerformanceRegistry();
  for (const read of hotPageReads) {
    const statements = await capture(read.read);
    if (statements.length === 0) {
      throw new Error(`hot page read emitted no SQL: ${read.id}`);
    }
    for (const [i, statement] of statements.entries()) {
      registry.register(
        sqlContract({
          description: `Full-schema access paths for ${read.id}`,
          id: `hot-page.${read.id}.${i + 1}`,
          iterations: 1,
          plan: { policy: read.policy, statement },
          statement: { ...statement, sql: `EXPLAIN QUERY PLAN ${statement.sql}` },
          warmupIterations: 0,
          workClass: "route-db",
        }),
      );
    }
  }
  return registry;
}
