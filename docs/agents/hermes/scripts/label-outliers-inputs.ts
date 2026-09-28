import { Database } from "bun:sqlite";

export const INPUTS_PAGE_LIMIT = 1000;

export const MAX_INPUT_PAGES = 1000;

export type InputTrack = {
  albumId: string | null;
  artistIds: string[];
  embeddingBase64: string;
  labelId: string | null;
  trackId: string;
};

export type InputAlbum = { discogsStyles: string; id: string };

export type InputsPage = {
  albums: InputAlbum[];
  nextCursor: string | null;
  tracks: InputTrack[];
};

export type FetchedPage = { bytes: number; page: InputsPage };

export type PageFetch = (cursor: string | null) => Promise<FetchedPage>;

export type InputsRead = {
  bytes: number;
  durationMs: number;
  pages: number;
  tracks: number;
};

const SCORING_SCHEMA = [
  `create table tracks (track_id text primary key, label_id text, album_id text,
     is_catalogue integer not null, has_embedding integer not null)`,
  "create table track_embeddings (track_id text primary key, embedding_blob blob not null)",
  "create table track_artists (track_id text not null, artist_id text not null)",
  "create table albums (id text primary key, discogs_styles text)",
];

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === "string") {
    return value;
  }

  throw new Error(`label-outlier inputs page carried a non-string ${field}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value !== "") {
    return value;
  }

  throw new Error(`label-outlier inputs page carried no ${field}`);
}

export function parseInputsPage(body: unknown): InputsPage {
  if (typeof body !== "object" || body === null) {
    throw new Error("label-outlier inputs page is not an object");
  }

  const record = body as Record<string, unknown>;

  if (record.ok !== true || !Array.isArray(record.tracks) || !Array.isArray(record.albums)) {
    throw new Error("label-outlier inputs page is missing ok, tracks, or albums");
  }

  const tracks = record.tracks.map((raw: unknown): InputTrack => {
    const track = (raw ?? {}) as Record<string, unknown>;

    if (!Array.isArray(track.artistIds)) {
      throw new Error("label-outlier inputs page carried a track without artistIds");
    }

    return {
      albumId: nullableString(track.albumId, "albumId"),
      artistIds: track.artistIds.map((artistId: unknown) => requiredString(artistId, "artistId")),
      embeddingBase64: requiredString(track.embeddingBase64, "embeddingBase64"),
      labelId: nullableString(track.labelId, "labelId"),
      trackId: requiredString(track.trackId, "trackId"),
    };
  });
  const albums = record.albums.map((raw: unknown): InputAlbum => {
    const album = (raw ?? {}) as Record<string, unknown>;

    return {
      discogsStyles: requiredString(album.discogsStyles, "discogsStyles"),
      id: requiredString(album.id, "album id"),
    };
  });

  return { albums, nextCursor: nullableString(record.nextCursor ?? null, "nextCursor"), tracks };
}

export function createScoringFile(path: string): Database {
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA journal_mode = OFF");
  database.run("PRAGMA synchronous = OFF");

  for (const statement of SCORING_SCHEMA) {
    database.run(statement);
  }

  return database;
}

export function appendInputsPage(database: Database, page: InputsPage): void {
  const insertTrack = database.prepare(
    "insert into tracks (track_id, label_id, album_id, is_catalogue, has_embedding) values (?, ?, ?, 1, 1)",
  );
  const insertEmbedding = database.prepare(
    "insert into track_embeddings (track_id, embedding_blob) values (?, ?)",
  );
  const insertArtist = database.prepare(
    "insert into track_artists (track_id, artist_id) values (?, ?)",
  );
  const insertAlbum = database.prepare(
    "insert into albums (id, discogs_styles) values (?, ?) on conflict(id) do nothing",
  );

  database.transaction(() => {
    for (const track of page.tracks) {
      insertTrack.run(track.trackId, track.labelId, track.albumId);
      insertEmbedding.run(track.trackId, Buffer.from(track.embeddingBase64, "base64"));

      for (const artistId of track.artistIds) {
        insertArtist.run(track.trackId, artistId);
      }
    }

    for (const album of page.albums) {
      insertAlbum.run(album.id, album.discogsStyles);
    }
  })();
}

export function finishScoringFile(database: Database): void {
  database.run("create index tracks_label_id_idx on tracks (label_id)");
}

export async function buildScoringFile(
  database: Database,
  fetchPage: PageFetch,
  options: { maxPages?: number; now?: () => number } = {},
): Promise<InputsRead> {
  const maxPages = options.maxPages ?? MAX_INPUT_PAGES;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const read: InputsRead = { bytes: 0, durationMs: 0, pages: 0, tracks: 0 };
  let cursor: string | null = null;

  while (true) {
    if (read.pages >= maxPages) {
      throw new Error(`the label-outlier inputs walk did not end within ${maxPages} pages`);
    }

    const { bytes, page } = await fetchPage(cursor);

    if (page.nextCursor !== null && (page.nextCursor === cursor || page.tracks.length === 0)) {
      throw new Error("the label-outlier inputs cursor stopped advancing");
    }

    appendInputsPage(database, page);
    read.pages += 1;
    read.tracks += page.tracks.length;
    read.bytes += bytes;

    if (page.nextCursor === null) {
      break;
    }

    cursor = page.nextCursor;
  }

  finishScoringFile(database);
  read.durationMs = Math.round(now() - started);

  return read;
}
