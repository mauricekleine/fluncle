import { type Client } from "@libsql/client";

import { beforeAll, describe, expect, it } from "vitest";

import { createIntegrationDb } from "../../src/lib/server/integration-db";
import { seedScale } from "./scale-seed";

const SCALE = 400;
const FINDINGS = 40;

let db: Client;

async function count(sql: string): Promise<number> {
  const result = await db.execute(sql);

  return Number(result.rows[0]?.n ?? -1);
}

beforeAll(async () => {
  db = await createIntegrationDb();
  await seedScale(db, {
    albums: 10,
    artistSocials: 20,
    artists: 20,
    findings: FINDINGS,
    frontier: 20,
    labels: 5,
    onProgress: () => {},
    scale: SCALE,
  });
});

describe("seedScale seeds the maintained mirrors, not their DDL defaults", () => {
  it("seeds the regime it was asked for", async () => {
    expect(await count("select count(*) as n from tracks")).toBe(SCALE);
    expect(await count("select count(*) as n from findings")).toBe(FINDINGS);
  });

  it("keeps has_embedding equal to the vector's presence on every row", async () => {
    expect(
      await count(
        `select count(*) as n from tracks
         where has_embedding <> exists (select 1 from track_embeddings te
                                        where te.track_id = tracks.track_id)`,
      ),
    ).toBe(0);

    expect(await count("select count(*) as n from tracks where has_embedding = 1")).toBeGreaterThan(
      0,
    );
    expect(await count("select count(*) as n from tracks where has_embedding = 0")).toBeGreaterThan(
      0,
    );
  });

  it("keeps has_isrc equal to the ISRC's trimmed presence on every row", async () => {
    expect(
      await count(
        `select count(*) as n from tracks where has_isrc <> (isrc is not null and trim(isrc) <> '')`,
      ),
    ).toBe(0);
    expect(await count("select count(*) as n from tracks where has_isrc = 1")).toBeGreaterThan(0);
    expect(await count("select count(*) as n from tracks where has_isrc = 0")).toBeGreaterThan(0);
  });

  it("keeps is_catalogue equal to the findings anti-join on every row", async () => {
    expect(
      await count(
        `select count(*) as n
           from tracks t
           left join findings f on f.track_id = t.track_id
          where t.is_catalogue <> (f.track_id is null)`,
      ),
    ).toBe(0);

    expect(await count("select count(*) as n from tracks where is_catalogue = 0")).toBe(FINDINGS);
    expect(await count("select count(*) as n from tracks where is_catalogue = 1")).toBe(
      SCALE - FINDINGS,
    );
  });

  it("keeps each entity's hub counters equal to the edges it actually holds", async () => {
    expect(
      await count(`select count(*) as n from labels e
                    where e.renderable_track_count <>
                          (select count(*) from tracks t where t.label_id = e.id)
                       or e.certified_finding_count <>
                          (select count(*) from tracks t where t.label_id = e.id and t.is_catalogue = 0)`),
    ).toBe(0);
    expect(
      await count(`select count(*) as n from albums e
                    where e.renderable_track_count <>
                          (select count(*) from tracks t where t.album_id = e.id)
                       or e.certified_finding_count <>
                          (select count(*) from tracks t where t.album_id = e.id and t.is_catalogue = 0)`),
    ).toBe(0);
    expect(
      await count(`select count(*) as n from artists e
                    where e.renderable_track_count <>
                          (select count(*) from track_artists ta where ta.artist_id = e.id)`),
    ).toBe(0);

    expect(
      await count("select count(*) as n from artists where renderable_track_count > 0"),
    ).toBeGreaterThan(0);
    expect(
      await count("select count(*) as n from labels where renderable_track_count > 0"),
    ).toBeGreaterThan(0);
    expect(
      await count("select count(*) as n from albums where renderable_track_count > 0"),
    ).toBeGreaterThan(0);
  });
});
