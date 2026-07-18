// The remixer-credit stamp (RFC label-lineage-remixer U2), proven against the REAL migrated schema
// on an in-memory libSQL engine (the labels.test.ts harness). `getDb` is mocked to hand back the
// integration client so the REAL `stampRemixerRoles` (artists.ts) SQL runs; the deploy backfill
// (`backfillRemixerRoles`, scripts/backfill-remixer-roles.ts) takes a client directly.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillRemixerRoles } from "../../../scripts/backfill-remixer-roles";
import { createIntegrationDb } from "./integration-db";
import { stampRemixerRoles } from "./artists";

let db: Client;

async function seedTrack(trackId: string, title: string, artists: string[]): Promise<void> {
  await db.execute({
    args: [trackId, title, JSON.stringify(artists)],
    sql: `insert into tracks (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms)
          values (?, ?, ?, 'u', 'u', 0)`,
  });
}

async function seedArtist(id: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    args: [id, name, `slug-${id}`, now, now],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function link(trackId: string, artistId: string, position: number): Promise<void> {
  await db.execute({
    args: [trackId, artistId, position],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
  });
}

async function roleOf(trackId: string, artistId: string): Promise<null | string> {
  const result = await db.execute({
    args: [trackId, artistId],
    sql: `select role from track_artists where track_id = ? and artist_id = ?`,
  });

  return (result.rows[0]?.["role"] as null | string) ?? null;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("stampRemixerRoles", () => {
  it("stamps 'remixer' on the credited remixer and leaves the performer null", async () => {
    await seedTrack("t1", "Nobody Else (Calibre Remix)", ["Marcus Intalex", "Calibre"]);
    await seedArtist("a_marcus", "Marcus Intalex");
    await seedArtist("a_calibre", "Calibre");
    await link("t1", "a_marcus", 1);
    await link("t1", "a_calibre", 2);

    const stamped = await stampRemixerRoles(["t1"]);

    expect(stamped).toBe(1);
    expect(await roleOf("t1", "a_calibre")).toBe("remixer");
    expect(await roleOf("t1", "a_marcus")).toBeNull();
  });

  it("stamps nothing when the remixer is not a linked (certified) artist", async () => {
    // The title names Calibre, but only the original artist is linked — no row to stamp.
    await seedTrack("t2", "Nobody Else (Calibre Remix)", ["Marcus Intalex"]);
    await seedArtist("a_marcus2", "Marcus Intalex");
    await link("t2", "a_marcus2", 1);

    const stamped = await stampRemixerRoles(["t2"]);

    expect(stamped).toBe(0);
    expect(await roleOf("t2", "a_marcus2")).toBeNull();
  });

  it("stamps nothing for a non-remix title", async () => {
    await seedTrack("t3", "Nobody Else", ["Calibre"]);
    await seedArtist("a_cal3", "Calibre");
    await link("t3", "a_cal3", 1);

    expect(await stampRemixerRoles(["t3"])).toBe(0);
    expect(await roleOf("t3", "a_cal3")).toBeNull();
  });

  it("is idempotent — a second pass stamps nothing more", async () => {
    await seedTrack("t4", "Tune (S.P.Y Remix)", ["Origin", "S.P.Y"]);
    await seedArtist("a_origin", "Origin");
    await seedArtist("a_spy", "S.P.Y");
    await link("t4", "a_origin", 1);
    await link("t4", "a_spy", 2);

    expect(await stampRemixerRoles(["t4"])).toBe(1);
    expect(await stampRemixerRoles(["t4"])).toBe(0);
    expect(await roleOf("t4", "a_spy")).toBe("remixer");
  });
});

describe("backfillRemixerRoles (the deploy history catch-up)", () => {
  it("stamps remixers across history and leaves non-remixes untouched, idempotently", async () => {
    await seedTrack("h1", "Nobody Else (Calibre Remix)", ["Marcus Intalex", "Calibre"]);
    await seedTrack("h2", "Straight Up", ["Lenzman"]); // non-remix, no bracket/dash
    await seedTrack("h3", "Valley - Alix Perez VIP", ["Origin Unknown", "Alix Perez"]);
    await seedArtist("a_marcus", "Marcus Intalex");
    await seedArtist("a_calibre", "Calibre");
    await seedArtist("a_lenzman", "Lenzman");
    await seedArtist("a_ou", "Origin Unknown");
    await seedArtist("a_ap", "Alix Perez");
    await link("h1", "a_marcus", 1);
    await link("h1", "a_calibre", 2);
    await link("h2", "a_lenzman", 1);
    await link("h3", "a_ou", 1);
    await link("h3", "a_ap", 2);

    const first = await backfillRemixerRoles(db);

    expect(first.stamped).toBe(2); // Calibre on h1, Alix Perez on h3
    expect(await roleOf("h1", "a_calibre")).toBe("remixer");
    expect(await roleOf("h1", "a_marcus")).toBeNull();
    expect(await roleOf("h3", "a_ap")).toBe("remixer");
    expect(await roleOf("h2", "a_lenzman")).toBeNull();

    // Idempotent: a re-run stamps nothing more.
    expect((await backfillRemixerRoles(db)).stamped).toBe(0);
  });
});
