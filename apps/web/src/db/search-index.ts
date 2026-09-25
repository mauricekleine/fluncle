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

export async function ensureSearchIndex(client: Client): Promise<SearchIndexResult> {
  for (const statement of SEARCH_INDEX_DDL) {
    await client.execute(statement);
  }

  const counts = await client.execute(
    `select (select count(*) from tracks) as tracks, (select count(*) from tracks_fts) as indexed`,
  );
  const row = counts.rows[0];
  const trackCount = Number(row?.tracks ?? 0);
  const indexedCount = Number(row?.indexed ?? 0);

  if (trackCount === indexedCount) {
    return { indexed: indexedCount, rebuilt: false };
  }

  await client.execute(`delete from tracks_fts`);
  await client.execute(
    `insert into tracks_fts (rowid, track_id, title, artists, album, label)
     select rowid, track_id, title, artists_json, album, label from tracks`,
  );

  return { indexed: trackCount, rebuilt: true };
}
