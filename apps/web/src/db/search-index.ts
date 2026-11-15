import { type Client } from "@libsql/client";

const SEARCH_INDEX_DDL = [
  `create virtual table if not exists tracks_fts using fts5(
     track_id unindexed,
     title,
     artists,
     album,
     label,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `create trigger if not exists tracks_fts_insert after insert on tracks begin
     insert into tracks_fts (rowid, track_id, title, artists, album, label)
     values (new.rowid, new.track_id, new.title, new.artists_json, new.album, new.label);
   end`,
  `create trigger if not exists tracks_fts_delete after delete on tracks begin
     delete from tracks_fts where rowid = old.rowid;
   end`,
  `create trigger if not exists tracks_fts_update
   after update of title, artists_json, album, label on tracks begin
     delete from tracks_fts where rowid = old.rowid;
     insert into tracks_fts (rowid, track_id, title, artists, album, label)
     values (new.rowid, new.track_id, new.title, new.artists_json, new.album, new.label);
   end`,
];

export type SearchIndexResult = {
  indexed: number;

  rebuilt: boolean;
};

async function rebuildSearchIndex(client: Client): Promise<void> {
  await client.execute(`delete from tracks_fts`);
  await client.execute(
    `insert into tracks_fts (rowid, track_id, title, artists, album, label)
     select rowid, track_id, title, artists_json, album, label from tracks`,
  );
}

export async function ensureSearchIndexSchema(client: Client): Promise<{ rebuilt: boolean }> {
  for (const statement of SEARCH_INDEX_DDL) {
    await client.execute(statement);
  }

  const probe = await client.execute(
    `select exists (select 1 from tracks) as has_tracks,
            exists (select 1 from tracks_fts) as has_index`,
  );
  const row = probe.rows[0];

  if (Number(row?.has_tracks ?? 0) === 1 && Number(row?.has_index ?? 0) === 0) {
    await rebuildSearchIndex(client);
    return { rebuilt: true };
  }

  return { rebuilt: false };
}

function withDeadline<T>(work: Promise<T>, deadlineMs: number | undefined): Promise<T> {
  if (deadlineMs === undefined) {
    return work;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`search index count exceeded ${deadlineMs} ms`)),
        deadlineMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function reconcileSearchIndex(
  client: Client,
  options: { countDeadlineMs?: number } = {},
): Promise<SearchIndexResult> {
  const counts = await withDeadline(
    client.execute(
      `select (select count(*) from tracks) as tracks, (select count(*) from tracks_fts) as indexed`,
    ),
    options.countDeadlineMs,
  );
  const row = counts.rows[0];
  const trackCount = Number(row?.tracks ?? 0);
  const indexedCount = Number(row?.indexed ?? 0);

  if (trackCount === indexedCount) {
    return { indexed: indexedCount, rebuilt: false };
  }

  await rebuildSearchIndex(client);

  return { indexed: trackCount, rebuilt: true };
}

export async function ensureSearchIndex(client: Client): Promise<SearchIndexResult> {
  const schema = await ensureSearchIndexSchema(client);
  const reconciled = await reconcileSearchIndex(client);

  return { indexed: reconciled.indexed, rebuilt: schema.rebuilt || reconciled.rebuilt };
}
