import { type Client, createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_DB_CONCURRENCY } from "../lib/database-concurrency";
import { ensureSearchIndex, ensureSearchIndexSchema, reconcileSearchIndex } from "./search-index";

let client: Client;

beforeEach(async () => {
  client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
  await client.execute(
    "create table tracks (track_id text primary key, title text, artists_json text, album text, label text)",
  );
});

afterEach(() => {
  client.close();
});

async function insertTrack(id: string, title: string): Promise<void> {
  await client.execute({
    args: [id, title, '["Artist"]', "Album", "Label"],
    sql: "insert into tracks values (?, ?, ?, ?, ?)",
  });
}

async function indexedCount(): Promise<number> {
  const result = await client.execute("select count(*) as n from tracks_fts");
  return Number(result.rows[0]?.n);
}

describe("search index maintenance", () => {
  it("builds an empty index over existing tracks in the schema step", async () => {
    await insertTrack("a1", "First");
    await insertTrack("b2", "Second");

    await expect(ensureSearchIndexSchema(client)).resolves.toEqual({ rebuilt: true });
    expect(await indexedCount()).toBe(2);
    await expect(ensureSearchIndexSchema(client)).resolves.toEqual({ rebuilt: false });
  });

  it("reports an empty-index rebuild from the combined step", async () => {
    await insertTrack("a1", "First");

    await expect(ensureSearchIndex(client)).resolves.toEqual({ indexed: 1, rebuilt: true });
    await expect(ensureSearchIndex(client)).resolves.toEqual({ indexed: 1, rebuilt: false });
  });

  it("leaves partial drift to the reconcile step", async () => {
    await ensureSearchIndexSchema(client);
    await insertTrack("a1", "First");
    await insertTrack("b2", "Second");
    await client.execute("delete from tracks_fts where track_id = 'b2'");

    await expect(ensureSearchIndexSchema(client)).resolves.toEqual({ rebuilt: false });
    expect(await indexedCount()).toBe(1);
    await expect(reconcileSearchIndex(client)).resolves.toEqual({ indexed: 2, rebuilt: true });
    expect(await indexedCount()).toBe(2);
  });

  it("rejects a count that outlives its deadline", async () => {
    await ensureSearchIndexSchema(client);
    const stalled = {
      execute: () => new Promise(() => {}),
    } as unknown as Client;

    await expect(reconcileSearchIndex(stalled, { countDeadlineMs: 10 })).rejects.toThrow(
      "search index count exceeded 10 ms",
    );
  });
});
