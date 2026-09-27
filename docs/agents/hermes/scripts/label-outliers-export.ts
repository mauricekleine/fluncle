import { Database } from "bun:sqlite";
import { rename, rm, stat } from "node:fs/promises";

export const SCORING_EXPORT_FILE = "label-outliers-inputs.db";

export const SCORING_EXPORT_REFRESH_MS = 20 * 60 * 60 * 1000;

export type ScoringExportStatus = {
  durationMs: number | null;
  error: string | null;
  exportedAt: string | null;
  status: "failed" | "fresh" | "written";
};

const EXPORT_SCHEMA = [
  `create table tracks (track_id text primary key, label_id text, album_id text,
     is_catalogue integer not null, has_embedding integer not null)`,
  "create table track_embeddings (track_id text primary key, embedding_blob blob not null)",
  "create table track_artists (track_id text not null, artist_id text not null)",
  "create table albums (id text primary key, discogs_styles text)",
  "create table export_meta (exported_at text not null, embedded_tracks integer not null)",
];

const EMBEDDINGS_FIRST = `from track_embeddings e
  cross join tracks t on t.track_id = e.track_id
  where t.is_catalogue = 1`;

export function copyScoringInputs(source: Database, target: Database, exportedAt: string): number {
  for (const statement of EXPORT_SCHEMA) {
    target.run(statement);
  }

  const insertTrack = target.prepare(
    "insert into tracks (track_id, label_id, album_id, is_catalogue, has_embedding) values (?, ?, ?, ?, ?)",
  );
  const insertEmbedding = target.prepare(
    "insert into track_embeddings (track_id, embedding_blob) values (?, ?)",
  );
  const insertArtist = target.prepare(
    "insert into track_artists (track_id, artist_id) values (?, ?)",
  );
  const insertAlbum = target.prepare("insert into albums (id, discogs_styles) values (?, ?)");
  let copied = 0;

  target.run("BEGIN");

  for (const row of source
    .query<
      {
        album_id: string | null;
        embedding_blob: Uint8Array;
        has_embedding: number;
        is_catalogue: number;
        label_id: string | null;
        track_id: string;
      },
      []
    >(
      `select t.track_id, t.label_id, t.album_id, t.is_catalogue, t.has_embedding, e.embedding_blob
         ${EMBEDDINGS_FIRST}`,
    )
    .iterate()) {
    insertTrack.run(row.track_id, row.label_id, row.album_id, row.is_catalogue, row.has_embedding);
    insertEmbedding.run(row.track_id, row.embedding_blob);
    copied += 1;
  }

  for (const row of source
    .query<{ artist_id: string; track_id: string }, []>(
      `select ta.track_id, ta.artist_id from track_embeddings e
         cross join tracks t on t.track_id = e.track_id
         cross join track_artists ta on ta.track_id = e.track_id
        where t.is_catalogue = 1`,
    )
    .iterate()) {
    insertArtist.run(row.track_id, row.artist_id);
  }

  for (const row of source
    .query<{ discogs_styles: string; id: string }, []>(
      "select id, discogs_styles from albums where discogs_styles is not null",
    )
    .iterate()) {
    insertAlbum.run(row.id, row.discogs_styles);
  }

  target.run("insert into export_meta (exported_at, embedded_tracks) values (?, ?)", [
    exportedAt,
    copied,
  ]);
  target.run("COMMIT");
  target.run("create index tracks_label_id_idx on tracks (label_id)");

  return copied;
}

export function readExportMeta(
  database: Database,
): { embeddedTracks: number; exportedAt: string } | null {
  const row = database
    .query<{ embedded_tracks: number; exported_at: string }, []>(
      "select exported_at, embedded_tracks from export_meta limit 1",
    )
    .get();

  return row ? { embeddedTracks: Number(row.embedded_tracks), exportedAt: row.exported_at } : null;
}

export async function exportedAtOf(exportFile: string): Promise<string | null> {
  if (!(await stat(exportFile).catch(() => undefined))) {
    return null;
  }

  const database = new Database(exportFile, { readonly: true, strict: true });

  try {
    return readExportMeta(database)?.exportedAt ?? null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export async function writeScoringExport(
  replicaFile: string,
  exportFile: string,
  exportedAt: string,
): Promise<void> {
  const temporary = `${exportFile}.tmp-${process.pid}`;
  await rm(temporary, { force: true });

  try {
    const source = new Database(replicaFile, { readonly: true, strict: true });
    const target = new Database(temporary, { create: true, strict: true });

    try {
      target.run("PRAGMA journal_mode = DELETE");
      source.run("BEGIN");
      copyScoringInputs(source, target, exportedAt);
      source.run("COMMIT");
    } finally {
      target.close();
      source.close();
    }

    await rename(temporary, exportFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function refreshScoringExport(
  replicaFile: string,
  exportFile: string,
  options: {
    now?: () => Date;
    refreshMs?: number;
    write?: typeof writeScoringExport;
  } = {},
): Promise<ScoringExportStatus> {
  const now = options.now ?? (() => new Date());
  const refreshMs = options.refreshMs ?? SCORING_EXPORT_REFRESH_MS;
  const write = options.write ?? writeScoringExport;

  try {
    const previous = await exportedAtOf(exportFile);
    const previousTime = previous ? Date.parse(previous) : Number.NaN;

    if (Number.isFinite(previousTime) && now().getTime() - previousTime < refreshMs) {
      return { durationMs: null, error: null, exportedAt: previous, status: "fresh" };
    }

    const started = performance.now();
    const exportedAt = now().toISOString();
    await write(replicaFile, exportFile, exportedAt);

    return {
      durationMs: Math.round(performance.now() - started),
      error: null,
      exportedAt,
      status: "written",
    };
  } catch (error) {
    return {
      durationMs: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      exportedAt: null,
      status: "failed",
    };
  }
}
