import { createClient, type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DUE_WORK_BACKFILLS } from "./due-work-registry";
import {
  advanceProjectionAudit,
  PROJECTION_AUDIT_SETTING_KEYS,
  type ProjectionAuditTarget,
} from "./projection-audit";
import { readCurrentProjectedTrackHubAnchors } from "./public-projection-cutover";
import {
  advancePublicAnchors,
  getProjectionStatusFor,
  setProjectionCutoverFor,
} from "./projection-operations";
import { TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE } from "./tracks-hub";

const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("projection production operations", () => {
  let db = createClient({ url: ":memory:" });

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.executeMultiple(`
      create table settings (key text primary key, value text not null);
      create table due_work (
        work_kind text not null, subject_type text not null, subject_id text not null default '',
        state text not null, sort_key text not null default '', next_due_at text not null default '',
        claim_expires_at text, generation text not null default '', updated_at text not null default '',
        primary key (work_kind, subject_type, subject_id)
      );
      create index due_work_ready_idx on due_work(work_kind, state, sort_key, subject_id)
        where state = 'ready';
      create index due_work_scheduled_idx on due_work(work_kind, state, next_due_at, subject_id)
        where state = 'scheduled';
      create index due_work_repair_idx on due_work(state, subject_type, subject_id)
        where state = 'repair';
      create index due_work_lease_idx on due_work(state, claim_expires_at, work_kind, subject_id)
        where state = 'leased';
      create table due_work_rebuilds (
        work_kind text not null, subject_type text not null, state text not null,
        scanned_count integer not null, projected_count integer not null
      );
      create table crawl_due_work (
        node_id text primary key, state text not null, hop integer not null default 0,
        demand_rank integer not null default 0, created_at text not null default '',
        next_due_at text, claim_expires_at text, generation text not null default '',
        updated_at text not null default ''
      );
      create index crawl_due_work_ready_idx
        on crawl_due_work(state, hop, demand_rank, created_at, node_id) where state = 'ready';
      create index crawl_due_work_scheduled_idx
        on crawl_due_work(state, next_due_at, node_id) where state = 'scheduled';
      create index crawl_due_work_repair_idx
        on crawl_due_work(state, node_id) where state = 'repair';
      create index crawl_due_work_lease_idx
        on crawl_due_work(state, claim_expires_at, node_id) where state = 'leased';
      create table crawl_projection_repairs (
        source_epoch integer not null default 0, source_type text not null default '',
        source_id text not null
      );
      create index crawl_projection_repairs_order_idx
        on crawl_projection_repairs(source_epoch, source_type, source_id);
      create table crawl_due_work_rebuilds (
        scope text primary key, state text not null, scanned_count integer not null,
        projected_count integer not null, source_digest text, projected_digest text
      );
      create table projection_repairs (
        projection text not null, source_epoch integer not null default 0,
        subject_type text not null default '', subject_id text not null default ''
      );
      create index projection_repairs_order_idx
        on projection_repairs(projection, source_epoch, subject_type, subject_id);
      create table tracks (track_id text primary key, release_date text, key text);
      create index tracks_release_date_track_id_idx on tracks(release_date desc, track_id desc);
      create table public_aggregate_membership (
        track_id text primary key, release_date_bucket text, key_bucket text
      );
      create table public_aggregate_counts (
        aggregate_kind text not null, bucket text not null, track_count integer not null,
        primary key (aggregate_kind, bucket)
      );
      create table public_aggregate_state (
        scope text primary key, state text not null, scanned_count integer not null,
        projected_entry_count integer not null, source_digest text, projected_digest text,
        source_epoch integer not null, aggregate_epoch integer not null,
        default_track_total integer not null, release_hub_order_epoch integer not null,
        generation text not null
      );
      create table artist_qualification_state (
        scope text primary key, state text not null, scanned_count integer not null,
        projected_qualified_count integer not null, source_digest text, projected_digest text,
        source_epoch integer not null, projection_epoch integer not null
      );
      create table hub_page_anchor_validity (
        hub text not null, clause_hash text not null, anchor_format_version integer not null,
        order_epoch integer not null, generation text not null, published_at text,
        primary key (hub, clause_hash)
      );
      create table hub_page_anchors (
        hub text not null, clause_hash text not null, anchors_json text not null,
        fingerprint text not null default '', computed_at text not null default '',
        primary key (hub, clause_hash)
      );
    `);
    for (const definition of DUE_WORK_BACKFILLS) {
      await db.execute({
        args: [definition.workKind, definition.subjectType],
        sql: `insert into due_work_rebuilds
          (work_kind, subject_type, state, scanned_count, projected_count)
          values (?, ?, 'complete', 0, 0)`,
      });
    }
    await db.execute({
      args: [EMPTY_DIGEST, EMPTY_DIGEST],
      sql: `insert into crawl_due_work_rebuilds
        (scope, state, scanned_count, projected_count, source_digest, projected_digest)
        values ('frontier', 'complete', 0, 0, ?, ?)`,
    });
    await db.execute({
      args: [EMPTY_DIGEST, EMPTY_DIGEST],
      sql: `insert into public_aggregate_state
        (scope, state, scanned_count, projected_entry_count, source_digest, projected_digest,
         source_epoch, aggregate_epoch, default_track_total, release_hub_order_epoch, generation)
        values ('tracks', 'complete', 0, 0, ?, ?, 0, 0, 0, 0, 'agg')`,
    });
    await db.execute({
      args: [EMPTY_DIGEST, EMPTY_DIGEST],
      sql: `insert into artist_qualification_state
        (scope, state, scanned_count, projected_qualified_count, source_digest, projected_digest,
         source_epoch, projection_epoch) values ('artists', 'complete', 0, 0, ?, ?, 0, 0)`,
    });
    await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `insert into hub_page_anchor_validity
        (hub, clause_hash, anchor_format_version, order_epoch, generation)
        values (?, ?, 1, 0, 'agg')`,
    });
    await db.execute({
      args: [
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
        `${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}:agg:0000000000`,
      ],
      sql: `insert into hub_page_anchors (hub, clause_hash, anchors_json) values (?, ?, '[]')`,
    });
    for (const target of Object.keys(PROJECTION_AUDIT_SETTING_KEYS) as ProjectionAuditTarget[]) {
      await db.execute({
        args: [
          PROJECTION_AUDIT_SETTING_KEYS[target],
          JSON.stringify({
            buckets: {},
            complete: true,
            cursor: null,
            definition: DUE_WORK_BACKFILLS.length,
            lane: "complete",
            matched: true,
            projectedCount: 0,
            projectedDigest: "0".repeat(64),
            sourceCount: 0,
            sourceDigest: "0".repeat(64),
            sourceEpoch:
              target === "artist_qualification" || target === "public_aggregates" ? 0 : null,
            startedAt: "2026-01-01T00:00:00.000Z",
            target,
            version: 1,
          }),
        ],
        sql: `insert into settings (key, value) values (?, ?)`,
      });
    }
  });

  afterEach(() => db.close());

  it("reports dark readiness and opens only fixed setting keys", async () => {
    const before = await getProjectionStatusFor(db);
    expect(before.cutovers).toEqual({
      crawlDueWork: false,
      publicProjections: false,
      trackDueWork: false,
    });
    expect(before.readyToOpen).toEqual({
      crawlDueWork: true,
      publicProjections: true,
      trackDueWork: true,
    });

    const after = await setProjectionCutoverFor(db, {
      enabled: true,
      target: "track_due_work",
    });
    expect(after.cutovers.trackDueWork).toBe(true);
    expect(
      (await db.execute(`select key, value from settings`)).rows.map((row) => [row.key, row.value]),
    ).toContainEqual(["track_work_due_cutover_enabled", "true"]);

    const publicStatus = await setProjectionCutoverFor(db, {
      enabled: true,
      target: "public_projections",
    });
    expect(publicStatus.cutovers.publicProjections).toBe(true);
  });

  it("caps growing-table probes, reports truncation, and keeps every probe on its fixed index", async () => {
    for (let index = 0; index < 125; index += 1) {
      const id = String(index).padStart(3, "0");
      await db.execute({
        args: [`ready-${id}`],
        sql: `insert into due_work
          (work_kind, subject_type, subject_id, state) values ('finding.note', 'track', ?, 'ready')`,
      });
      await db.execute({
        args: [`repair-${id}`],
        sql: `insert into due_work
          (work_kind, subject_type, subject_id, state) values ('source-repair', 'track', ?, 'repair')`,
      });
    }

    let captured: InStatement[] = [];
    const traced = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        captured = statements;
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };
    const status = await getProjectionStatusFor(traced);
    expect(status.projections.trackDueWork.backlog.ready).toEqual({
      count: 100,
      truncated: true,
    });
    expect(status.projections.trackDueWork.repairs.total).toEqual({
      count: 100,
      truncated: true,
    });
    expect(status.projections.trackDueWork.ready).toBe(false);

    const expectedIndexes = [
      "due_work_ready_idx",
      "due_work_scheduled_idx",
      "due_work_lease_idx",
      "due_work_repair_idx",
      "crawl_due_work_ready_idx",
      "crawl_due_work_scheduled_idx",
      "crawl_due_work_lease_idx",
      "crawl_due_work_repair_idx",
      "crawl_projection_repairs_order_idx",
      "projection_repairs_order_idx",
      "projection_repairs_order_idx",
    ];
    const probes = captured.slice(1, 12);
    expect(probes).toHaveLength(expectedIndexes.length);
    for (const [index, statement] of probes.entries()) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = typeof statement === "string" ? [] : statement.args;
      expect(sql.toLowerCase()).not.toMatch(/count\s*\(|group\s+by/);
      expect(sql.toLowerCase()).toContain("limit ?");
      const plan = await db.execute({
        args,
        sql: `explain query plan ${sql}`,
      });
      const detail = plan.rows
        .flatMap((row) => (typeof row.detail === "string" ? [row.detail] : []))
        .join("\n");
      expect(detail).toContain(expectedIndexes[index]);
      expect(detail).not.toContain("USE TEMP B-TREE");
    }
  });

  it("refuses an open with repair debt but always permits the rollback close", async () => {
    await db.execute(`insert into due_work (work_kind, subject_type, state)
      values ('finding.note', 'track', 'repair')`);
    await expect(
      setProjectionCutoverFor(db, { enabled: true, target: "track_due_work" }),
    ).rejects.toThrow(/not converged/);

    const closed = await setProjectionCutoverFor(db, {
      enabled: false,
      target: "track_due_work",
    });
    expect(closed.cutovers.trackDueWork).toBe(false);
  });

  it("atomically rejects an open when readiness changes before the conditional write", async () => {
    let raced = false;
    const racingClient = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        const first = statements[0];
        const firstSql = typeof first === "string" ? first : first?.sql;
        if (!raced && firstSql?.includes("select ?, 'true'")) {
          raced = true;
          await db.execute(`insert into due_work
            (work_kind, subject_type, subject_id, state)
            values ('source-repair', 'track', 'raced', 'repair')`);
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    await expect(
      setProjectionCutoverFor(racingClient, { enabled: true, target: "track_due_work" }),
    ).rejects.toThrow(/not converged/);
    expect(
      (await db.execute(`select value from settings where key = 'track_work_due_cutover_enabled'`))
        .rows,
    ).toHaveLength(0);
  });

  it("rejects structurally valid JSON that fails the runtime anchor completeness rules", async () => {
    await db.execute({
      args: [TRACKS_HUB_PAGE_SIZE],
      sql: `update public_aggregate_state set default_track_total = ? where scope = 'tracks'`,
    });
    await db.execute({
      args: [
        JSON.stringify([{ id: "wrong-page", key: "2026-01-01", page: 3 }]),
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
      ],
      sql: `update hub_page_anchors set anchors_json = ? where hub = ?`,
    });

    const status = await getProjectionStatusFor(db);
    expect(status.projections.publicAggregates.anchorsReady).toBe(false);
    expect(status.readyToOpen.publicProjections).toBe(false);
    await expect(
      setProjectionCutoverFor(db, { enabled: true, target: "public_projections" }),
    ).rejects.toThrow(/not converged/);
  });

  it("atomically revalidates published anchors after the public preflight read", async () => {
    let raced = false;
    const racingClient = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        const first = statements[0];
        const firstSql = typeof first === "string" ? first : first?.sql;
        if (!raced && firstSql?.includes("select ?, 'true'")) {
          raced = true;
          await db.execute({
            args: [TRACKS_HUB_ANCHOR_ADDRESS.hub],
            sql: `update hub_page_anchors set anchors_json = '{}'
              where hub = ?`,
          });
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    await expect(
      setProjectionCutoverFor(racingClient, {
        enabled: true,
        target: "public_projections",
      }),
    ).rejects.toThrow(/not converged/);
    expect(
      (
        await db.execute(
          `select value from settings where key = 'public_projection_cutover_enabled'`,
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("produces exact public aggregate proof one row per audit call", async () => {
    await db.execute({
      args: [PROJECTION_AUDIT_SETTING_KEYS.public_aggregates],
      sql: `delete from settings where key = ?`,
    });
    await db.executeMultiple(`
      insert into tracks (track_id, release_date, key) values
        ('a', '2024-01-01', 'Am'), ('b', '2025-01-01', 'Dm');
      insert into public_aggregate_membership (track_id, release_date_bucket, key_bucket) values
        ('a', '2024', 'Am'), ('b', '2025', 'Dm');
      insert into public_aggregate_counts (aggregate_kind, bucket, track_count) values
        ('key', 'Am', 1), ('key', 'Dm', 1),
        ('release_date_bucket', '2024', 1), ('release_date_bucket', '2025', 1);
      update public_aggregate_state set default_track_total = 2 where scope = 'tracks';
    `);

    let complete = false;
    for (let step = 0; step < 20 && !complete; step += 1) {
      const result = await advanceProjectionAudit(db, "public_aggregates", 1);
      expect(result.processed).toBeLessThanOrEqual(1);
      complete = result.complete;
      if (complete) {
        expect(result.matched).toBe(true);
      }
    }
    expect(complete).toBe(true);
  });

  it("builds scaled anchors in bounded shards and publishes only a complete document", async () => {
    await db.execute(`delete from hub_page_anchor_validity`);
    await db.execute(`delete from hub_page_anchors`);
    for (let index = 0; index < 250; index += 1) {
      const id = `scaled-${String(index).padStart(3, "0")}`;
      await db.execute({
        args: [id, `2026-${String((index % 12) + 1).padStart(2, "0")}-01`],
        sql: `insert into tracks (track_id, release_date) values (?, ?)`,
      });
    }
    await db.execute(`update public_aggregate_state
      set default_track_total = 250, projected_entry_count = 250,
          generation = 'scaled', release_hub_order_epoch = 1
      where scope = 'tracks'`);

    let complete = false;
    let maximumStateBytes = 0;
    for (let step = 0; step < 50 && !complete; step += 1) {
      const result = await advancePublicAnchors(db, 7);
      expect(result.processed).toBeLessThanOrEqual(7);
      complete = result.complete;
      const state = await db.execute(
        `select length(value) as bytes from settings
          where key = 'projection_rebuild_public_anchors_v1'`,
      );
      maximumStateBytes = Math.max(maximumStateBytes, Number(state.rows[0]?.bytes ?? 0));
      if (!complete) {
        expect(
          (await db.execute(`select count(*) as total from hub_page_anchor_validity`)).rows[0]
            ?.total,
        ).toBe(0);
      }
    }
    expect(complete).toBe(true);
    expect(maximumStateBytes).toBeLessThan(512);
    const shardStats = (
      await db.execute(`select count(*) as total, max(length(anchors_json)) as maximum_bytes
        from hub_page_anchors where clause_hash like '%:scaled:%'`)
    ).rows[0];
    expect(Number(shardStats?.total)).toBeGreaterThan(1);
    expect(Number(shardStats?.maximum_bytes)).toBeLessThan(512);
    const published = await readCurrentProjectedTrackHubAnchors(
      db,
      TRACKS_HUB_ANCHOR_ADDRESS,
      TRACKS_HUB_PAGE_SIZE,
    );
    expect(published).toMatchObject({ total: 250 });
    expect(published?.anchors.map((anchor) => anchor.page)).toEqual(
      Array.from({ length: Math.floor(250 / TRACKS_HUB_PAGE_SIZE) }, (_, index) => index + 2),
    );
  });
});
