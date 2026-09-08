import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProjectionTestDb } from "../../test/projection-schema";
import { hubLeafPageStart } from "./hub-page-anchors";
import { advanceProjectionAudit, PROJECTION_AUDIT_SETTING_KEYS } from "./projection-audit";
import { advanceProjectionFor, advancePublicAnchors } from "./projection-operations";
import {
  PUBLIC_ANCHOR_AMENDMENT_MAX_SHARD_WRITES,
  PUBLIC_ANCHOR_LEAF_SPLIT_ROWS,
} from "./public-anchor-amendments";
import {
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  publicAnchorOrderChangeKey,
  readProjectedAnchorLeafForPageStart,
  readProjectedTrackHubPageStart,
} from "./public-projection-cutover";
import {
  markPublicTrackSourceChangedStatements,
  publicTrackSourceVersion,
} from "./public-projections";
import {
  projectedTracksHubIdPageQueries,
  TRACKS_HUB_ANCHOR_ADDRESS,
  TRACKS_HUB_PAGE_SIZE,
  tracksHubIdPageQuery,
} from "./tracks-hub";

const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The box sweep's per-family request budget for the public families. */
const SWEEP_STEPS = 4;

function releaseDateFor(index: number): null | string {
  if (index % 25 === 7) {
    return null;
  }
  const year = 2000 + ((index * 7) % 26);
  const month = String(((index * 11) % 12) + 1).padStart(2, "0");
  const day = String(((index * 13) % 28) + 1).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function trackIdFor(index: number): string {
  return `track-${String(index).padStart(5, "0")}`;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected a text value, received ${typeof value}`);
  }
  return value;
}

describe("page-local public anchor maintenance", () => {
  let db: Client;
  const now = () => new Date().toISOString();

  beforeEach(async () => {
    db = await createProjectionTestDb();
    await db.execute({
      args: [EMPTY_DIGEST, EMPTY_DIGEST],
      sql: `insert into public_aggregate_state
        (scope, state, scanned_count, projected_entry_count, source_digest, projected_digest,
         source_epoch, aggregate_epoch, default_track_total, release_hub_order_epoch, generation)
        values ('tracks', 'complete', 0, 0, ?, ?, 0, 0, 0, 1, 'leaf')`,
    });
    await db.execute({
      args: [EMPTY_DIGEST, EMPTY_DIGEST],
      sql: `insert into artist_qualification_state
        (scope, state, scanned_count, projected_qualified_count, source_digest, projected_digest,
         source_epoch, projection_epoch) values ('artists', 'complete', 0, 0, ?, ?, 0, 0)`,
    });
    await db.execute({
      args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, "true"],
      sql: `insert into settings (key, value) values (?, ?)`,
    });
  });

  afterEach(() => db.close());

  async function seedCorpus(count: number, dated = false): Promise<void> {
    for (let start = 0; start < count; start += 200) {
      const statements = [];
      for (let index = start; index < Math.min(count, start + 200); index += 1) {
        const releaseDate = dated ? `${2000 + (index % 26)}-01-01` : releaseDateFor(index);
        statements.push({
          args: [trackIdFor(index), releaseDate],
          sql: `insert into tracks (track_id, release_date) values (?, ?)`,
        });
        statements.push({
          args: [
            trackIdFor(index),
            releaseDate === null ? null : releaseDate.slice(0, 4),
            publicTrackSourceVersion({ key: null, releaseDate }),
            now(),
          ],
          sql: `insert into public_aggregate_membership
            (track_id, release_date_bucket, key_bucket, generation, source_version, updated_at)
            values (?, ?, null, 'live', ?, ?)`,
        });
      }
      await db.batch(statements, "write");
    }
    await db.execute(`insert into public_aggregate_counts (aggregate_kind, bucket, track_count)
      select 'release_date_bucket', substr(release_date, 1, 4), count(*) from tracks
      where release_date is not null group by 2`);
    await db.execute({
      args: [count, count, count],
      sql: `update public_aggregate_state
        set default_track_total = ?, projected_entry_count = ?, source_entry_count = ?
        where scope = 'tracks'`,
    });
  }

  async function buildAnchors(limit: number, maxSteps = 500): Promise<number> {
    for (let step = 1; step <= maxSteps; step += 1) {
      const result = await advancePublicAnchors(db, limit);
      expect(result.processed).toBeLessThanOrEqual(limit);
      if (result.complete) {
        return step;
      }
    }
    throw new Error("anchor build did not complete");
  }

  async function insertTrack(trackId: string, releaseDate: null | string): Promise<void> {
    await db.batch(
      [
        {
          args: [trackId, releaseDate],
          sql: `insert into tracks (track_id, release_date) values (?, ?)`,
        },
        ...markPublicTrackSourceChangedStatements(
          trackId,
          publicTrackSourceVersion({ key: null, releaseDate }),
          { now: now() },
        ),
      ],
      "write",
    );
  }

  async function deleteTrack(trackId: string): Promise<void> {
    await db.batch(
      [
        { args: [trackId], sql: `delete from tracks where track_id = ?` },
        ...markPublicTrackSourceChangedStatements(trackId, "deleted", { now: now() }),
      ],
      "write",
    );
  }

  async function moveTrack(trackId: string, releaseDate: null | string): Promise<void> {
    await db.batch(
      [
        {
          args: [releaseDate, trackId],
          sql: `update tracks set release_date = ? where track_id = ?`,
        },
        ...markPublicTrackSourceChangedStatements(
          trackId,
          publicTrackSourceVersion({ key: null, releaseDate }),
          { now: now() },
        ),
      ],
      "write",
    );
  }

  /** The bounded repair action as the box sweep issues it, up to the sweep's step budget. */
  async function repairUntilComplete(maxSteps = SWEEP_STEPS): Promise<number> {
    for (let step = 1; step <= maxSteps; step += 1) {
      const result = await advanceProjectionFor(db, {
        action: "repair",
        includeStatus: false,
        limit: 100,
        target: "public_aggregates",
      });
      expect(result.processed).toBeLessThanOrEqual(100);
      if (result.complete) {
        return step;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  type BatchStatement = Parameters<Client["batch"]>[0][number];

  function statementSql(statement: BatchStatement): string {
    if (typeof statement === "string") {
      return statement;
    }
    if (Array.isArray(statement)) {
      return statement[0];
    }
    return statement.sql;
  }

  function observeCommittedBatches(
    observe: (
      statements: Parameters<Client["batch"]>[0],
      results: Awaited<ReturnType<Client["batch"]>>,
    ) => Promise<void> | void,
  ): Client {
    return {
      batch: async (
        statements: Parameters<Client["batch"]>[0],
        mode?: Parameters<Client["batch"]>[1],
      ) => {
        const results = await db.batch(statements, mode);
        await observe(statements, results);
        return results;
      },
      execute: db.execute.bind(db),
    } as Client;
  }

  async function countCommittedAnchorShardWrites(
    run: (observed: Client) => Promise<void>,
  ): Promise<number> {
    let writes = 0;
    const observed = observeCommittedBatches((statements, results) => {
      for (const [index, statement] of statements.entries()) {
        if (
          /^\s*(?:insert\s+into|update|delete\s+from)\s+hub_page_anchors\b/i.test(
            statementSql(statement),
          )
        ) {
          writes += results[index]?.rowsAffected ?? 0;
        }
      }
    });
    await run(observed);
    return writes;
  }

  async function shardSnapshot(): Promise<Map<string, string>> {
    const rows = await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:leaf:%`],
      sql: `select clause_hash, anchors_json, fingerprint from hub_page_anchors
        where hub = ? and clause_hash like ?`,
    });
    return new Map(
      rows.rows.map((row) => [
        text(row.clause_hash),
        `${text(row.anchors_json)}|${text(row.fingerprint)}`,
      ]),
    );
  }

  function shardWrites(before: Map<string, string>, after: Map<string, string>): number {
    let writes = 0;
    for (const [key, value] of after) {
      if (before.get(key) !== value) {
        writes += 1;
      }
    }
    for (const key of before.keys()) {
      if (!after.has(key)) {
        writes += 1;
      }
    }
    return writes;
  }

  async function epochs(): Promise<{ aggregate: number; validity: number | undefined }> {
    const aggregate = await db.execute(`select release_hub_order_epoch as epoch
      from public_aggregate_state where scope = 'tracks'`);
    const validity = await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `select order_epoch from hub_page_anchor_validity where hub = ? and clause_hash = ?`,
    });
    const validityEpoch = validity.rows[0]?.order_epoch;
    return {
      aggregate: Number(aggregate.rows[0]?.epoch),
      validity: validityEpoch === undefined ? undefined : Number(validityEpoch),
    };
  }

  /** Every numbered page the projected document serves equals the exact source order page. */
  async function expectServedPagesExact(): Promise<void> {
    const total = Number(
      (await db.execute(`select count(*) as total from tracks`)).rows[0]?.total ?? -1,
    );
    const pages = Math.max(Math.ceil(total / TRACKS_HUB_PAGE_SIZE), 1);
    for (let page = 1; page <= pages; page += 1) {
      const resolved = await readProjectedTrackHubPageStart(
        db,
        TRACKS_HUB_ANCHOR_ADDRESS,
        TRACKS_HUB_PAGE_SIZE,
        page,
      );
      expect(resolved, `page ${page} start`).toBeDefined();
      expect(resolved?.total).toBe(total);
      const start = resolved?.start;
      if (start === undefined) {
        throw new Error(`page ${page} of ${pages} has no projected start`);
      }
      expect(start.offset).toBeLessThan(TRACKS_HUB_PAGE_SIZE);
      const queries = projectedTracksHubIdPageQueries(start, TRACKS_HUB_PAGE_SIZE);
      const primary = await db.execute(queries.primary);
      const remaining = TRACKS_HUB_PAGE_SIZE - primary.rows.length;
      const fill =
        remaining > 0 && queries.nullFill !== undefined
          ? await db.execute(queries.nullFill(remaining))
          : { rows: [] };
      const served = [...primary.rows, ...fill.rows].map((row) => text(row.track_id));
      const expected = await db.execute({
        args: [TRACKS_HUB_PAGE_SIZE, (page - 1) * TRACKS_HUB_PAGE_SIZE],
        sql: `select track_id from tracks order by release_date desc, track_id desc limit ? offset ?`,
      });
      expect(served, `page ${page} of ${pages}`).toEqual(
        expected.rows.map((row) => text(row.track_id)),
      );
      expect(served.length, `page ${page} rows`).toBeGreaterThan(total === 0 ? -1 : 0);
    }
    const pastEnd = await readProjectedTrackHubPageStart(
      db,
      TRACKS_HUB_ANCHOR_ADDRESS,
      TRACKS_HUB_PAGE_SIZE,
      pages + 1,
    );
    expect(pastEnd).toMatchObject({ start: undefined, total });
  }

  async function expectPublishedAtCurrentEpoch(): Promise<void> {
    const current = await epochs();
    expect(current.validity).toBe(current.aggregate);
    // Servable means the pager resolves page one from the projected document, whatever its format.
    expect(
      await readProjectedTrackHubPageStart(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE, 1),
    ).toMatchObject({ start: { after: null, offset: 0, phase: "non_null" } });
  }

  /** Read the generation named by validity directly, even while the aggregate epoch is ahead. */
  async function expectStoredPublishedDocumentExact(): Promise<void> {
    const publication = await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `select validity.generation,
          (select coalesce(sum(json_extract(shard.fingerprint, '$.n')), 0)
            from hub_page_anchors shard
            where shard.hub = validity.hub
              and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
              and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff')
            as total
        from hub_page_anchor_validity validity
        where validity.hub = ? and validity.clause_hash = ?`,
    });
    const generation = publication.rows[0]?.generation;
    const total = Number(publication.rows[0]?.total ?? -1);
    expect(typeof generation).toBe("string");
    expect(total).toBe(
      Number((await db.execute(`select count(*) as total from tracks`)).rows[0]?.total),
    );
    if (typeof generation !== "string") {
      throw new Error("published anchor generation is missing");
    }
    const pages = Math.max(Math.ceil(total / TRACKS_HUB_PAGE_SIZE), 1);
    for (let page = 1; page <= pages; page += 1) {
      const pageStart = (page - 1) * TRACKS_HUB_PAGE_SIZE;
      const leaf =
        page === 1
          ? undefined
          : await readProjectedAnchorLeafForPageStart(
              db,
              TRACKS_HUB_ANCHOR_ADDRESS,
              generation,
              pageStart,
            );
      const start =
        page === 1
          ? { after: null, offset: 0, phase: "non_null" as const }
          : leaf === undefined
            ? undefined
            : hubLeafPageStart(pageStart, leaf, TRACKS_HUB_PAGE_SIZE);
      expect(start, `stored published page ${page} start`).toBeDefined();
      if (start === undefined) {
        continue;
      }
      const queries = projectedTracksHubIdPageQueries(start, TRACKS_HUB_PAGE_SIZE);
      const primary = await db.execute(queries.primary);
      const remaining = TRACKS_HUB_PAGE_SIZE - primary.rows.length;
      const fill =
        remaining > 0 && queries.nullFill !== undefined
          ? await db.execute(queries.nullFill(remaining))
          : { rows: [] };
      const served = [...primary.rows, ...fill.rows].map((row) => text(row.track_id));
      const expected = await db.execute({
        args: [TRACKS_HUB_PAGE_SIZE, pageStart],
        sql: `select track_id from tracks order by release_date desc, track_id desc limit ? offset ?`,
      });
      expect(served, `stored published page ${page}`).toEqual(
        expected.rows.map((row) => text(row.track_id)),
      );
    }
  }

  /** The public route's fail-open source read keeps every page in the published range reachable. */
  async function expectPublishedRangeReachable(): Promise<void> {
    const total = Number((await db.execute(`select count(*) as total from tracks`)).rows[0]?.total);
    const pages = Math.max(Math.ceil(total / TRACKS_HUB_PAGE_SIZE), 1);
    for (let page = 1; page <= pages; page += 1) {
      const projected = await readProjectedTrackHubPageStart(
        db,
        TRACKS_HUB_ANCHOR_ADDRESS,
        TRACKS_HUB_PAGE_SIZE,
        page,
      );
      if (projected?.start === undefined) {
        const fallback = await db.execute(
          tracksHubIdPageQuery({}, TRACKS_HUB_PAGE_SIZE, (page - 1) * TRACKS_HUB_PAGE_SIZE),
        );
        expect(fallback.rows.length, `published-range fallback page ${page}`).toBeGreaterThan(0);
        continue;
      }
      const queries = projectedTracksHubIdPageQueries(projected.start, TRACKS_HUB_PAGE_SIZE);
      const primary = await db.execute(queries.primary);
      const remaining = TRACKS_HUB_PAGE_SIZE - primary.rows.length;
      const fill =
        remaining > 0 && queries.nullFill !== undefined
          ? await db.execute(queries.nullFill(remaining))
          : { rows: [] };
      expect(
        primary.rows.length + fill.rows.length,
        `published-range projected page ${page}`,
      ).toBeGreaterThan(0);
    }
    const projectedPastEnd = await readProjectedTrackHubPageStart(
      db,
      TRACKS_HUB_ANCHOR_ADDRESS,
      TRACKS_HUB_PAGE_SIZE,
      pages + 1,
    );
    if (projectedPastEnd !== undefined) {
      expect(projectedPastEnd).toMatchObject({ start: undefined, total });
    }
    const pastEnd = await db.execute(
      tracksHubIdPageQuery({}, TRACKS_HUB_PAGE_SIZE, pages * TRACKS_HUB_PAGE_SIZE),
    );
    expect(pastEnd.rows, "the first past-end page remains a 404").toHaveLength(0);
  }

  it("rewrites at most the stated constant number of shards for one subject-level repair", async () => {
    const corpus = 1000;
    await seedCorpus(corpus);
    await buildAnchors(10);
    const leaves = (await shardSnapshot()).size;
    expect(corpus).toBeGreaterThanOrEqual(20 * PUBLIC_ANCHOR_AMENDMENT_MAX_SHARD_WRITES);
    expect(leaves).toBeGreaterThan(PUBLIC_ANCHOR_AMENDMENT_MAX_SHARD_WRITES);
    await expectServedPagesExact();

    const firstShard = (await shardSnapshot()).keys().next().value as string | undefined;
    expect(firstShard).toBeDefined();
    const identicalRepeatWrites = await countCommittedAnchorShardWrites(async (observed) => {
      if (firstShard === undefined) {
        return;
      }
      await observed.batch(
        [
          {
            args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, firstShard],
            sql: `update hub_page_anchors set anchors_json = anchors_json
              where hub = ? and clause_hash = ?`,
          },
          {
            args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, firstShard],
            sql: `update hub_page_anchors set anchors_json = anchors_json
              where hub = ? and clause_hash = ?`,
          },
        ],
        "write",
      );
    });
    expect(identicalRepeatWrites).toBe(2);

    const subjects: Array<[string, () => Promise<void>]> = [
      ["insert", () => insertTrack("track-inserted", "2013-06-15")],
      ["delete", () => deleteTrack(trackIdFor(500))],
      ["move", () => moveTrack(trackIdFor(250), "2019-02-02")],
      ["move into the NULL zone", () => moveTrack(trackIdFor(251), null)],
      ["insert a NULL date", () => insertTrack("track-inserted-null", null)],
      ["delete a NULL date", () => deleteTrack(trackIdFor(7))],
    ];
    for (const [label, mutate] of subjects) {
      await mutate();
      // A generous step budget lets a whole-document rebuild finish too, so the shard count below
      // is what discriminates page-local maintenance from a rebuild.
      let steps = 0;
      const writes = await countCommittedAnchorShardWrites(async (observed) => {
        for (steps = 1; steps <= 50; steps += 1) {
          const result = await advanceProjectionFor(observed, {
            action: "repair",
            includeStatus: false,
            limit: 100,
            target: "public_aggregates",
          });
          expect(result.processed).toBeLessThanOrEqual(100);
          if (result.complete) {
            return;
          }
        }
      });
      const after = await shardSnapshot();
      expect(writes, label).toBeLessThanOrEqual(PUBLIC_ANCHOR_AMENDMENT_MAX_SHARD_WRITES);
      expect(steps, label).toBeLessThanOrEqual(SWEEP_STEPS);
      expect(after.size, label).toBeGreaterThanOrEqual(leaves - 1);
      await expectPublishedAtCurrentEpoch();
      await expectServedPagesExact();
    }
    expect(
      (
        await db.execute({
          args: [publicAnchorOrderChangeKey(0), publicAnchorOrderChangeKey(1_000_000)],
          sql: `select count(*) as total from settings where key >= ? and key <= ?`,
        })
      ).rows[0]?.total,
    ).toBe(0);
  });

  it("splits a run that outgrows the ceiling and drops a run that empties", async () => {
    await seedCorpus(300, true);
    await buildAnchors(100);
    const leavesBefore = (await shardSnapshot()).size;
    for (let index = 0; index <= PUBLIC_ANCHOR_LEAF_SPLIT_ROWS - 100; index += 1) {
      await insertTrack(`track-grow-${String(index).padStart(3, "0")}`, "2025-06-01");
      expect(await repairUntilComplete()).toBeLessThanOrEqual(SWEEP_STEPS);
    }
    const sizes = (
      await db.execute({
        args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:leaf:%`],
        sql: `select clause_hash, json_extract(fingerprint, '$.n') as n from hub_page_anchors
          where hub = ? and clause_hash like ? order by clause_hash`,
      })
    ).rows;
    expect(sizes.length).toBe(leavesBefore + 1);
    expect(sizes.every((row) => Number(row.n) <= PUBLIC_ANCHOR_LEAF_SPLIT_ROWS)).toBe(true);
    expect(sizes.some((row) => text(row.clause_hash).includes("."))).toBe(true);
    await expectPublishedAtCurrentEpoch();
    await expectServedPagesExact();

    for (let index = 0; index <= PUBLIC_ANCHOR_LEAF_SPLIT_ROWS - 100; index += 1) {
      await deleteTrack(`track-grow-${String(index).padStart(3, "0")}`);
      expect(await repairUntilComplete()).toBeLessThanOrEqual(SWEEP_STEPS);
    }
    // Empty the second run entirely; the head run is the one run that is never dropped.
    const secondRun = (
      await db.execute(`select track_id from tracks
        order by release_date desc, track_id desc limit 100 offset 100`)
    ).rows.map((row) => text(row.track_id));
    for (const trackId of secondRun) {
      await deleteTrack(trackId);
      expect(await repairUntilComplete()).toBeLessThanOrEqual(SWEEP_STEPS);
    }
    const remaining = (await shardSnapshot()).size;
    expect(remaining).toBeLessThan(sizes.length);
    expect(remaining).toBeGreaterThanOrEqual(2);
    await expectPublishedAtCurrentEpoch();
    await expectServedPagesExact();
  });

  it("resumes an interrupted generation rebuild from its durable cursor", async () => {
    await seedCorpus(500, true);
    expect(await advancePublicAnchors(db, 100)).toEqual({ complete: false, processed: 100 });
    expect(await advancePublicAnchors(db, 100)).toEqual({ complete: false, processed: 100 });
    const stateBefore = JSON.parse(
      text(
        (
          await db.execute(
            `select value from settings where key = 'projection_rebuild_public_anchors_v1'`,
          )
        ).rows[0]?.value,
      ),
    ) as { orderEpoch: number; processed: number; shard: number };
    expect(stateBefore).toMatchObject({ orderEpoch: 1, processed: 200, shard: 2 });
    const builtBefore = await shardSnapshot();
    expect(builtBefore.size).toBe(2);

    // One change behind the cursor and one ahead of it, both through the real repair path. The one
    // repair request drains both markers and then amends the built prefix instead of restarting.
    await insertTrack("track-newest", "2999-01-01");
    await insertTrack("track-oldest", "1900-01-01");
    const repair = await advanceProjectionFor(db, {
      action: "repair",
      includeStatus: false,
      limit: 100,
      target: "public_aggregates",
    });
    expect(repair.complete).toBe(false);
    const stateAfter = JSON.parse(
      text(
        (
          await db.execute(
            `select value from settings where key = 'projection_rebuild_public_anchors_v1'`,
          )
        ).rows[0]?.value,
      ),
    ) as { orderEpoch: number; processed: number; shard: number };
    expect(stateAfter).toMatchObject({ orderEpoch: 3, processed: 201, shard: 2 });
    const builtAfter = await shardSnapshot();
    expect(builtAfter.size).toBe(2);
    expect(shardWrites(builtBefore, builtAfter)).toBe(1);

    // The remaining 301 rows take exactly four more bounded steps to publish; a restart would need
    // two purge steps and six source pages before its publication.
    for (let step = 0; step < 4; step += 1) {
      expect((await epochs()).validity).toBeUndefined();
      expect((await advancePublicAnchors(db, 100)).complete).toBe(false);
    }
    await expectPublishedAtCurrentEpoch();
    await expectServedPagesExact();
  });

  it("keeps published pages exact and reachable when writes interrupt an amendment", async () => {
    await seedCorpus(600);
    await buildAnchors(100);
    expect(await repairUntilComplete()).toBeLessThanOrEqual(SWEEP_STEPS);
    await expectStoredPublishedDocumentExact();
    await expectPublishedRangeReachable();

    // More than one amendment step can consume, all inside the head run so every intermediate
    // publication can be checked whole against the source state at that exact commit.
    for (let index = 0; index < 12; index += 1) {
      await insertTrack(`track-pending-${String(index).padStart(2, "0")}`, "2999-01-01");
    }

    let injected = false;
    let publicationChecks = 0;
    const observed = observeCommittedBatches(async (statements, results) => {
      const published = statements.some(
        (statement, index) =>
          /^\s*update\s+hub_page_anchor_validity\s+set\s+order_epoch\b/i.test(
            statementSql(statement),
          ) && (results[index]?.rowsAffected ?? 0) > 0,
      );
      if (!published) {
        return;
      }
      await expectStoredPublishedDocumentExact();
      publicationChecks += 1;
      if (!injected) {
        injected = true;
        await insertTrack("track-midflight-insert", "2999-01-02");
        await deleteTrack("track-pending-00");
        await moveTrack("track-pending-01", "2998-12-31");
      }
    });

    const interrupted = await advanceProjectionFor(observed, {
      action: "repair",
      includeStatus: false,
      limit: 100,
      target: "public_aggregates",
    });
    expect(interrupted.complete).toBe(false);
    expect(injected).toBe(true);
    expect(publicationChecks).toBe(1);
    expect(
      Number(
        (
          await db.execute(`select count(*) as total from projection_repairs
            where projection = 'public_aggregates'`)
        ).rows[0]?.total,
      ),
    ).toBe(3);
    expect(
      Number(
        (
          await db.execute({
            args: [publicAnchorOrderChangeKey(0), publicAnchorOrderChangeKey(1_000_000)],
            sql: `select count(*) as total from settings where key >= ? and key <= ?`,
          })
        ).rows[0]?.total,
      ),
    ).toBeGreaterThan(0);
    expect(
      await readProjectedTrackHubPageStart(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE, 1),
    ).toBeUndefined();
    await expectPublishedRangeReachable();

    let sawOutstandingAfterStep = false;
    for (let step = 0; step < 10; step += 1) {
      const result = await advanceProjectionFor(observed, {
        action: "repair",
        includeStatus: false,
        limit: 100,
        target: "public_aggregates",
      });
      await expectPublishedRangeReachable();
      if (result.complete) {
        expect(sawOutstandingAfterStep).toBe(true);
        expect(publicationChecks).toBeGreaterThan(1);
        await expectPublishedAtCurrentEpoch();
        await expectServedPagesExact();
        return;
      }
      sawOutstandingAfterStep = true;
    }
    throw new Error("interrupted amendment did not converge");
  });

  it("keeps every published document exact under continuous interleaved writes", async () => {
    await seedCorpus(600);
    await buildAnchors(100);
    expect(await repairUntilComplete()).toBeLessThanOrEqual(SWEEP_STEPS);
    await expectPublishedAtCurrentEpoch();
    await expectServedPagesExact();

    let seed = 20260906;
    const random = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    let nextInsert = 0;
    for (let round = 0; round < 40; round += 1) {
      const operations = 1 + random(3);
      for (let index = 0; index < operations; index += 1) {
        const ids = (
          await db.execute({
            args: [random(700)],
            sql: `select track_id from tracks order by track_id limit 1 offset ?`,
          })
        ).rows;
        const victim = ids[0]?.track_id;
        const choice = random(3);
        if (choice === 0 || victim === undefined) {
          nextInsert += 1;
          await insertTrack(
            `track-live-${String(nextInsert).padStart(4, "0")}`,
            releaseDateFor(nextInsert * 3),
          );
        } else if (choice === 1) {
          await deleteTrack(text(victim));
        } else {
          await moveTrack(text(victim), releaseDateFor(random(1000)));
        }
      }
      expect(await repairUntilComplete(), `round ${round}`).toBeLessThanOrEqual(SWEEP_STEPS);
      await expectPublishedAtCurrentEpoch();
      await expectServedPagesExact();
    }

    // The exact audit runs dark and re-derives the served boundaries of the amended leaf document.
    await db.execute({
      args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY],
      sql: `update settings set value = 'false' where key = ?`,
    });
    await db.execute({
      args: [PROJECTION_AUDIT_SETTING_KEYS.public_aggregates],
      sql: `delete from settings where key = ?`,
    });
    for (let step = 0; step < 200; step += 1) {
      const result = await advanceProjectionAudit(db, "public_aggregates", 100);
      if (result.complete) {
        expect(result.matched).toBe(true);
        return;
      }
    }
    throw new Error("public aggregate audit did not complete");
  });
});
