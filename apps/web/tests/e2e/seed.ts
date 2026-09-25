import { createClient, type Client } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import {
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedEmbedding,
  seedLabel,
  seedMixtape,
  seedTrack,
} from "../../src/lib/server/integration-db";
import { EMBEDDING_DIMS } from "../../src/lib/server/embedding";
import { SEARCH_STYLES } from "../../src/lib/search-styles";
import { LIBSQL_URL } from "./stack";

const ARTIST = { id: "e2e-artist-nova", name: "Nova Kestrel", slug: "nova-kestrel" };
const LABEL = { id: "e2e-label-driftwave", name: "Driftwave Audio", slug: "driftwave-audio" };
const ALBUM = { id: "e2e-album-signal", name: "Signal Bloom", slug: "signal-bloom" };

type FindingFixture = { artist: string; logId: string; title: string };

const FINDINGS: FindingFixture[] = [
  { artist: "Nova Kestrel", logId: "701.1.0A", title: "Synthetic Aurora" },
  { artist: "Cobalt Mirage", logId: "702.2.0B", title: "Neon Undertow" },
  { artist: "Halcyon Drift", logId: "703.3.0C", title: "Glassbottom Reverie" },
  { artist: "Pulsewidth", logId: "704.4.0D", title: "Cathode Sunrise" },
  { artist: "Marrow & Vane", logId: "705.5.0E", title: "Velvet Static" },
  { artist: "Sable Lung", logId: "706.6.0F", title: "Paper Lantern Riot" },
  { artist: "Quiet Cartel", logId: "707.7.0G", title: "Ferrite Bloom" },
  { artist: "Ostrich Ballet", logId: "708.8.0H", title: "Tungsten Lullaby" },
];

const MIXTAPE = { id: "e2e-mixtape-1", logId: "700.F.1A", title: "Dream Sector One" };

export const SEEDED_FINDING_TITLES = FINDINGS.map((finding) => finding.title);
export const SEEDED_MIXTAPE_TITLE = MIXTAPE.title;

export const SEEDED_SAVE_TARGET_LOG_ID = FINDINGS[0]?.logId ?? "";
export const SEEDED_SAVE_TARGET_TITLE = FINDINGS[0]?.title ?? "";

export const SEEDED_FINDING_LOG_IDS = FINDINGS.map((finding) => finding.logId);

export const SEEDED_GRAPH_FINDING = {
  artist: FINDINGS[0]?.artist ?? "",
  logId: FINDINGS[0]?.logId ?? "",
  title: FINDINGS[0]?.title ?? "",
};

export const SEEDED_GRAPH_ENTITIES = {
  album: { name: ALBUM.name, slug: ALBUM.slug },
  artist: { name: ARTIST.name, slug: ARTIST.slug },
  label: { name: LABEL.name, slug: LABEL.slug },
};

const BASE_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

const RADIO_FINDING = {
  artist: "Lantern Wick",
  logId: "709.9.0J",
  observationAudioUrl: "https://found.fluncle.com/709.9.0J/observation.mp3",

  observationDurationMs: 600_000,
  title: "Salt Marsh Signal",
  trackId: "e2e-track-radio",
} as const;

export const SEEDED_RADIO_FINDING = {
  artist: RADIO_FINDING.artist,
  logId: RADIO_FINDING.logId,
  title: RADIO_FINDING.title,
};

export const SEEDED_LEAD_NOTE =
  "Came down through a green sector and the air went thick before I clocked the coordinate.";

export const SEEDED_LEAD = {
  artist: FINDINGS[1]?.artist ?? "",
  logId: FINDINGS[1]?.logId ?? "",
  title: FINDINGS[1]?.title ?? "",
  trackId: "e2e-track-2",
};

export const SEEDED_LEAD_COVER_URL = "https://found.fluncle.com/e2e/lead-cover.jpg";

export const SEEDED_COVERED_FINDINGS = [
  { coverUrl: "https://found.fluncle.com/e2e/cover-3.jpg", trackId: "e2e-track-3" },
  { coverUrl: "https://found.fluncle.com/e2e/cover-4.jpg", trackId: "e2e-track-4" },
] as const;

export const SEEDED_STORY_FINDING = {
  logId: FINDINGS[2]?.logId ?? "",
  title: FINDINGS[2]?.title ?? "",
  trackId: "e2e-track-3",
  videoUrl: "https://found.fluncle.com/e2e/story-3.mp4",
} as const;

export const SEEDED_CATALOGUE_RELEASE = {
  artist: "Ashen Relay",
  title: "Undertow Ledger",
  trackId: "e2e-track-catalogue-1",
};

export const SEEDED_FUTURE_RELEASE = {
  artist: "Ashen Relay",
  title: "Tomorrow's Ledger",
  trackId: "e2e-track-future",
} as const;

export const SEEDED_PARTIAL_RELEASE = {
  artist: "Ashen Relay",
  title: "This Year Ledger",
  trackId: "e2e-track-year",
} as const;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DESTINATION_ALBUM = {
  id: "e2e-album-ledger",
  name: "Undertow Ledger",
  slug: "undertow-ledger",
};

export const SEEDED_DESTINATION_TRACK = {
  appleMusicUrl: "https://music.apple.com/us/album/undertow/1?i=2",
  artist: "Ashen Relay",
  coverUrl: "https://found.fluncle.com/e2e/ledger-cover.jpg",
  title: "Undertow Ledger",
  trackId: "e2e-track-destination",
} as const;

export const SEEDED_DESTINATION_NEIGHBOUR = {
  artist: "Cinder Vane",
  title: "Halide Drift",
  trackId: "e2e-track-neighbour",
} as const;

export const SEEDED_THIN_TRACK = {
  artist: "Pale Kestrel",
  title: "Nettle Dust",
  trackId: "e2e-track-thin",
} as const;

export const SEEDED_BARE_TRACK = {
  artist: "Winter Aerial",
  title: "Gravel Sky",
  trackId: "e2e-track-bare",
} as const;

function axisVector(axis: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => (index === axis ? 1 : 0));
}

async function seedDestinationFixtures(client: Client): Promise<void> {
  await seedAlbum(client, DESTINATION_ALBUM);

  for (const track of [
    SEEDED_DESTINATION_TRACK,
    SEEDED_DESTINATION_NEIGHBOUR,
    SEEDED_THIN_TRACK,
    SEEDED_BARE_TRACK,
  ]) {
    await seedCatalogueTrack(client, {
      artists: [track.artist],
      label: LABEL.name,
      title: track.title,
      trackId: track.trackId,
    });
  }

  for (const track of [SEEDED_DESTINATION_TRACK, SEEDED_DESTINATION_NEIGHBOUR]) {
    await client.execute({
      args: [
        DESTINATION_ALBUM.id,
        DESTINATION_ALBUM.name,
        daysAgo(20),
        "coverUrl" in track ? track.coverUrl : "https://found.fluncle.com/e2e/neighbour-cover.jpg",
        "appleMusicUrl" in track
          ? track.appleMusicUrl
          : "https://music.apple.com/us/album/halide/3?i=4",
        track.trackId,
      ],
      sql: `update tracks
               set album_id = ?, album = ?, release_date = ?, album_image_url = ?,
                   apple_music_url = ?, bpm = 174, key = 'F minor', isrc = 'GBE2E2600001'
             where track_id = ?`,
    });
  }

  await client.execute({
    args: [SEEDED_BARE_TRACK.trackId],
    sql: `update tracks
             set spotify_uri = null, spotify_url = null, duration_ms = 0
           where track_id = ?`,
  });

  await seedEmbedding(client, SEEDED_DESTINATION_TRACK.trackId, axisVector(5));
  await seedEmbedding(client, SEEDED_DESTINATION_NEIGHBOUR.trackId, axisVector(6));
  await seedEmbedding(client, SEEDED_THIN_TRACK.trackId, axisVector(900));
}

function angleVector(angle: number): number[] {
  const vector: number[] = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);

  return vector;
}

export const SEEDED_SONIC_ANCHOR = { title: FINDINGS[0]?.title ?? "", trackId: "e2e-track-1" };

export const SEEDED_SONIC_NEIGHBOUR = { title: FINDINGS[1]?.title ?? "", trackId: "e2e-track-2" };

const STYLE = SEARCH_STYLES[0];
const STYLE_TITLES = [
  "Moonlit Current",
  "Soft Signal",
  "Blue Horizon",
  "Low Tide Motion",
  "Afterglow Circuit",
  "Quiet Orbit",
] as const;

export const SEEDED_STYLE = {
  rankedTitles: [...STYLE_TITLES],
  rankedTrackIds: STYLE_TITLES.map((_title, index) => `e2e-style-${index + 1}`),
  slug: STYLE.slug,
} as const;

export const SEEDED_LEAD_CENTROID_TRACK = {
  artist: STYLE.anchors[0],
  title: "Satellite Without a Signal",
  trackId: "e2e-style-lead-centroid",
} as const;

function styleVector(angle: number): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  vector[40] = Math.cos(angle);
  vector[41] = Math.sin(angle);

  return vector;
}

function artistTitle(slug: string): string {
  return slug === "lsb"
    ? "LSB"
    : slug.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function seedStyleFixtures(client: Client): Promise<void> {
  for (const slug of STYLE.anchors) {
    const artistId = `e2e-style-artist-${slug}`;
    await seedArtist(client, { id: artistId, name: artistTitle(slug), slug });
    await client.execute({
      args: [artistId, JSON.stringify(styleVector(0)), new Date(BASE_EPOCH_MS).toISOString()],
      sql: `insert into artist_centroids
              (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
            values (?, vector32(?), ?, 'e2e-style-corpus', 1)`,
    });
  }

  for (const [index, trackId] of SEEDED_STYLE.rankedTrackIds.entries()) {
    const slug = STYLE.anchors[index] ?? STYLE.anchors[0];
    await seedCatalogueTrack(client, {
      artists: [artistTitle(slug)],
      title: STYLE_TITLES[index],
      trackId,
    });
    await client.execute({
      args: ["2025-01-01", `https://found.fluncle.com/e2e/style-${index + 1}.mp3`, trackId],
      sql: `update tracks set release_date = ?, preview_url = ? where track_id = ?`,
    });
    await client.execute({
      args: [trackId, `e2e-style-artist-${slug}`],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
    });
    await seedEmbedding(client, trackId, styleVector((index + 1) * 0.06));
  }

  await seedCatalogueTrack(client, {
    artists: [artistTitle(SEEDED_LEAD_CENTROID_TRACK.artist)],
    title: SEEDED_LEAD_CENTROID_TRACK.title,
    trackId: SEEDED_LEAD_CENTROID_TRACK.trackId,
  });
  await client.execute({
    args: ["2025-01-01", SEEDED_LEAD_CENTROID_TRACK.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });
  await client.execute({
    args: [
      SEEDED_LEAD_CENTROID_TRACK.trackId,
      `e2e-style-artist-${SEEDED_LEAD_CENTROID_TRACK.artist}`,
    ],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });
}

const EMBEDDED_TRACKS: { angle: number; trackId: string }[] = [
  { angle: 0, trackId: SEEDED_SONIC_ANCHOR.trackId },
  { angle: 0.1, trackId: SEEDED_SONIC_NEIGHBOUR.trackId },
  { angle: 0.6, trackId: "e2e-track-3" },
  { angle: 1.2, trackId: "e2e-track-4" },
];

export async function seedE2eData(client: Client): Promise<void> {
  await client.execute({
    args: ["sonar_sonic_enabled", "true"],
    sql: `insert into settings (key, value) values (?, ?)`,
  });
  await seedArtist(client, ARTIST);
  await seedLabel(client, LABEL);
  await seedAlbum(client, ALBUM);

  for (const [index, finding] of FINDINGS.entries()) {
    const trackId = `e2e-track-${index + 1}`;

    const addedAt = new Date(BASE_EPOCH_MS - index * 60_000).toISOString();

    await seedTrack(client, {
      addedAt,
      artists: [finding.artist],
      label: LABEL.name,
      logId: finding.logId,
      title: finding.title,
      trackId,
    });
  }

  await client.execute({
    args: [ALBUM.id, LABEL.id, "e2e-track-1"],
    sql: `update tracks set album_id = ?, label_id = ? where track_id = ?`,
  });
  await client.execute({
    args: ["e2e-track-1", ARTIST.id],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });

  for (const table of ["albums", "artists"]) {
    await client.execute({
      args: [table === "albums" ? ALBUM.id : ARTIST.id],
      sql: `update ${table} set renderable_track_count = 1, certified_finding_count = 1 where id = ?`,
    });
  }

  await seedTrack(client, {
    addedAt: new Date(BASE_EPOCH_MS - FINDINGS.length * 60_000).toISOString(),
    artists: [RADIO_FINDING.artist],
    label: LABEL.name,
    logId: RADIO_FINDING.logId,
    title: RADIO_FINDING.title,
    trackId: RADIO_FINDING.trackId,
  });
  await client.execute({
    args: [
      new Date(BASE_EPOCH_MS).toISOString(),
      RADIO_FINDING.observationAudioUrl,
      RADIO_FINDING.observationDurationMs,
      new Date(BASE_EPOCH_MS).toISOString(),
      RADIO_FINDING.trackId,
    ],
    sql: `update findings
          set video_squared_at = ?,
              observation_audio_url = ?,
              observation_duration_ms = ?,
              observation_generated_at = ?
          where track_id = ?`,
  });

  await seedMixtape(client, {
    addedAt: new Date(BASE_EPOCH_MS + 60_000).toISOString(),
    id: MIXTAPE.id,
    logId: MIXTAPE.logId,
    title: MIXTAPE.title,
  });

  for (const embedded of EMBEDDED_TRACKS) {
    await seedEmbedding(client, embedded.trackId, angleVector(embedded.angle));
  }

  await seedFrontDoorFixtures(client);
  await seedDestinationFixtures(client);
  await stampLabelPointers(client);
  await seedStyleFixtures(client);
  await stampAlbumCounters(client);
  await stampLatestReleaseDates(client);
}

async function stampLatestReleaseDates(client: Client): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const released = (column: string) => `${column} glob '[0-9][0-9][0-9][0-9]*' and ${column} <= ?`;

  for (const [table, edge] of [
    ["labels", "tracks.label_id = labels.id"],
    ["albums", "tracks.album_id = albums.id"],
  ] as const) {
    await client.execute({
      args: [today],
      sql: `update ${table}
               set latest_release_date = (select max(tracks.release_date) from tracks
                                           where ${edge} and ${released("tracks.release_date")})`,
    });
  }
  await client.execute({
    args: [today],
    sql: `update artists
             set latest_release_date = (select max(tracks.release_date)
                                          from track_artists
                                          join tracks on tracks.track_id = track_artists.track_id
                                         where track_artists.artist_id = artists.id
                                           and ${released("tracks.release_date")})`,
  });
}

async function seedFrontDoorFixtures(client: Client): Promise<void> {
  await client.execute({
    args: [SEEDED_LEAD_NOTE, SEEDED_LEAD.trackId],
    sql: `update findings set note = ? where track_id = ?`,
  });
  await client.execute({
    args: [SEEDED_LEAD_COVER_URL, SEEDED_LEAD.trackId],
    sql: `update tracks set album_image_url = ? where track_id = ?`,
  });

  await client.execute({
    args: ["https://found.fluncle.com/e2e/lead-preview.mp3", SEEDED_LEAD.trackId],
    sql: `update tracks set preview_url = ? where track_id = ?`,
  });

  for (const covered of SEEDED_COVERED_FINDINGS) {
    await client.execute({
      args: [covered.coverUrl, covered.trackId],
      sql: `update tracks set album_image_url = ? where track_id = ?`,
    });
  }

  await client.execute({
    args: [SEEDED_STORY_FINDING.videoUrl, SEEDED_STORY_FINDING.trackId],
    sql: `update findings set video_url = ? where track_id = ?`,
  });

  await client.execute({
    args: [daysAgo(1), SEEDED_LEAD.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });

  await seedCatalogueTrack(client, {
    artists: [SEEDED_CATALOGUE_RELEASE.artist],
    label: LABEL.name,
    title: SEEDED_CATALOGUE_RELEASE.title,
    trackId: SEEDED_CATALOGUE_RELEASE.trackId,
  });
  await client.execute({
    args: [daysAgo(3), SEEDED_CATALOGUE_RELEASE.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });

  for (const [index] of FINDINGS.entries()) {
    await client.execute({
      args: [`https://found.fluncle.com/e2e/preview-${index + 1}.mp3`, `e2e-track-${index + 1}`],
      sql: `update tracks set preview_url = coalesce(preview_url, ?) where track_id = ?`,
    });
  }
  await client.execute({
    args: ["GBE2E2600002", SEEDED_CATALOGUE_RELEASE.trackId],
    sql: `update tracks set isrc = ? where track_id = ?`,
  });

  await seedCatalogueTrack(client, {
    artists: [SEEDED_FUTURE_RELEASE.artist],
    label: LABEL.name,
    title: SEEDED_FUTURE_RELEASE.title,
    trackId: SEEDED_FUTURE_RELEASE.trackId,
  });
  await client.execute({
    args: [daysAgo(-1), SEEDED_FUTURE_RELEASE.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });

  await seedCatalogueTrack(client, {
    artists: [SEEDED_PARTIAL_RELEASE.artist],
    label: LABEL.name,
    title: SEEDED_PARTIAL_RELEASE.title,
    trackId: SEEDED_PARTIAL_RELEASE.trackId,
  });
  await client.execute({
    args: [new Date().getUTCFullYear().toString(), SEEDED_PARTIAL_RELEASE.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });
}

async function stampLabelPointers(client: Client): Promise<void> {
  await client.execute({
    args: [LABEL.id, LABEL.name],
    sql: `update tracks set label_id = ? where label = ?`,
  });
  await client.execute({
    args: [LABEL.id],
    sql: `update labels
             set renderable_track_count =
                   (select count(*) from tracks where tracks.label_id = labels.id),
                 certified_finding_count =
                   (select count(*) from tracks
                     where tracks.label_id = labels.id and tracks.is_catalogue = 0)
           where id = ?`,
  });
}

async function stampAlbumCounters(client: Client): Promise<void> {
  await client.execute(`update albums
     set renderable_track_count =
           (select count(*) from tracks where tracks.album_id = albums.id),
         certified_finding_count =
           (select count(*) from tracks
             where tracks.album_id = albums.id and tracks.is_catalogue = 0)`);
}

async function main(): Promise<void> {
  const client = createClient({
    authToken: "e2e-local",
    concurrency: LOCAL_DB_CONCURRENCY,
    url: LIBSQL_URL,
  });

  await seedE2eData(client);
  client.close();
  console.log(
    `e2e seed: ${FINDINGS.length + 1} findings (1 radio-eligible) + 1 mixtape + 12 catalogue tracks + artist/label/albums + ${EMBEDDED_TRACKS.length + 9} embeddings.`,
  );
}

if (import.meta.main) {
  await main();
}
