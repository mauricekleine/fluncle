import { type Client } from "@libsql/client";

import { beforeAll, describe, expect, it } from "vitest";

import { createIntegrationDb } from "../../src/lib/server/integration-db";
import { seedScale } from "./scale-seed";

// THE PROOF RIG'S OWN PROOF (docs/db-scale-backlog).
//
// `bench-db-scale.ts` is the ONLY thing allowed to say an index or a stored column scales, because
// AGENTS.md forbids a scale claim made on `turso dev`. That makes this seeder load-bearing: every
// number the hosted gate produces is measured against the world it builds, so a column it forgets
// is not a cosmetic gap — it is a benchmark of a query that never ran.
//
// Two columns carry that risk, and both are MAINTAINED mirrors with a DDL default that is wrong for
// half these rows: `is_catalogue` defaults to 1 (Wave 2 keystone 1) and `has_embedding` defaults to
// 0 (Wave 2 #4/#7). This test pins them against the truth they mirror — the same equivalence the
// production write sites hold and `scripts/backfill-has-embedding.ts` reconciles — so a later column
// added to `tracks` and left out of the seeder fails here rather than in a green, meaningless bench.
//
// A SMALL scale on purpose: the invariant is per-row, so 400 rows prove it as well as 150k and the
// suite stays fast.

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
    // Both directions in one predicate: a flagged row with no vector (the funnel would OVER-report)
    // and a vector-carrying row left unflagged (it would UNDER-report, and the covering stage scan
    // would be timed against a column that is uniformly 0).
    expect(
      await count(
        `select count(*) as n from tracks where has_embedding <> (embedding_blob is not null)`,
      ),
    ).toBe(0);
    // …and the seeder actually makes both kinds of row, so the equivalence above is not vacuous.
    expect(await count("select count(*) as n from tracks where has_embedding = 1")).toBeGreaterThan(
      0,
    );
    expect(await count("select count(*) as n from tracks where has_embedding = 0")).toBeGreaterThan(
      0,
    );
  });

  it("keeps has_isrc equal to the ISRC's trimmed presence on every row", async () => {
    // The anchor drain order leads with this mirror, so a seeder that left it at the DDL default
    // would bench the worklist against a uniformly-0 first key — a walk that never ran.
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
    // The certified half is the one the DDL default gets wrong, so pin its size explicitly.
    expect(await count("select count(*) as n from tracks where is_catalogue = 0")).toBe(FINDINGS);
    expect(await count("select count(*) as n from tracks where is_catalogue = 1")).toBe(
      SCALE - FINDINGS,
    );
  });

  // The entity counters are the same class of trap one table over (Wave 2 keystone 2, and now the
  // gate the Wave 3-2 name→id resolution declines on). At the DDL default of 0 every read that
  // gates on them takes its other branch, so the bench would measure a world where the fast path
  // never runs — green, and about nothing.
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

    // …and the counters are not uniformly zero, so the equivalences above are not vacuous.
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
