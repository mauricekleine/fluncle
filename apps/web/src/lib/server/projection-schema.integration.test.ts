import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("materialized projection schema laws", () => {
  it("keeps crawl ordering lanes indexed and rejects invalid lease or retry shapes", async () => {
    const indexes = await db.execute(
      `select name, sql from sqlite_master
       where type = 'index' and tbl_name = 'crawl_due_work'
       order by name`,
    );

    expect(indexes.rows.map((row) => row.name)).toEqual([
      "crawl_due_work_claim_position_idx",
      "crawl_due_work_cleanup_idx",
      "crawl_due_work_label_slug_node_id_idx",
      "crawl_due_work_lease_idx",
      "crawl_due_work_parent_id_node_id_idx",
      "crawl_due_work_ready_idx",
      "crawl_due_work_release_ready_idx",
      "crawl_due_work_repair_idx",
      "crawl_due_work_scheduled_idx",
      "sqlite_autoindex_crawl_due_work_1",
    ]);
    expect(
      indexes.rows.find((row) => row.name === "crawl_due_work_release_ready_idx")?.sql,
    ).toContain("storable_rank");
    expect(
      indexes.rows.find((row) => row.name === "crawl_due_work_label_slug_node_id_idx")?.sql,
    ).toContain("`label_slug`,`node_id`");
    expect(
      indexes.rows.find((row) => row.name === "crawl_due_work_parent_id_node_id_idx")?.sql,
    ).toContain("`parent_id`,`node_id`");
    expect(indexes.rows.find((row) => row.name === "crawl_due_work_cleanup_idx")?.sql).toContain(
      "`generation`,`updated_at`,`node_id`",
    );

    await db.execute(`insert into crawl_due_work
      (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank,
       generation, source_version, updated_at)
      values ('release:a', 'release', 'ready', 0, 1, '2026-01-01', 0,
              'generation-a', 'source-a', '2026-01-01')`);

    await expect(
      db.execute(`insert into crawl_due_work
        (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank,
         generation, source_version, updated_at)
        values ('release:bad-retry', 'release', 'scheduled', 0, 1, '2026-01-01', 1,
                'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await db.execute(`insert into crawl_due_work
      (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank,
       claim_expires_at, claim_position, claim_token, claimed_by,
       generation, source_version, updated_at)
      values ('artist:a', 'artist', 'leased', 1, 0, '2026-01-01', null,
              '2026-01-02', 0, 'token-a', 'worker-a',
              'generation-a', 'source-a', '2026-01-01')`);

    await expect(
      db.execute(`insert into crawl_due_work
        (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank,
         claim_expires_at, claim_position, claim_token, claimed_by,
         generation, source_version, updated_at)
        values ('label:a', 'label', 'leased', 1, 0, '2026-01-01', null,
                '2026-01-02', 0, 'token-a', 'worker-a',
                'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/unique/i);
  });

  it("stores exact artist qualification and literal public aggregate buckets", async () => {
    await db.execute(`insert into artist_qualification
      (artist_id, certified_finding_count, enabled_credit_half_units, is_qualified,
       generation, source_version, updated_at)
      values ('artist:a', 0, 6, 1, 'generation-a', 'source-a', '2026-01-01')`);

    await expect(
      db.execute(`insert into artist_qualification
        (artist_id, certified_finding_count, enabled_credit_half_units, is_qualified,
         generation, source_version, updated_at)
        values ('artist:bad', 0, 5, 1, 'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    const contributionIndexes = await db.execute(
      `select name from sqlite_master
       where type = 'index' and tbl_name = 'artist_qualification_contributions'
       order by name`,
    );

    expect(contributionIndexes.rows.map((row) => row.name)).toEqual([
      "artist_qualification_contributions_artist_track_idx",
      "sqlite_autoindex_artist_qualification_contributions_1",
    ]);

    await db.execute(`insert into artist_qualification_contributions
      (track_id, artist_id, certified_contribution, enabled_credit_half_units,
       generation, source_version, updated_at)
      values ('track:a', 'artist:a', 1, 2, 'generation-a', 'source-a', '2026-01-01'),
             ('track:a', 'artist:b', 0, 1, 'generation-a', 'source-a', '2026-01-01')`);

    await expect(
      db.execute(`insert into artist_qualification_contributions
        (track_id, artist_id, certified_contribution, enabled_credit_half_units,
         generation, source_version, updated_at)
        values ('track:bad-certified', 'artist:a', 2, 0,
                'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db.execute(`insert into artist_qualification_contributions
        (track_id, artist_id, certified_contribution, enabled_credit_half_units,
         generation, source_version, updated_at)
        values ('track:bad-credit', 'artist:a', 0, 3,
                'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await db.execute(`insert into public_aggregate_counts
      (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
      values ('release_date_bucket', '', 1, 'generation-a', 'source-a', '2026-01-01'),
             ('release_date_bucket', '20x?', 2, 'generation-a', 'source-a', '2026-01-01'),
             ('key', 'C#m', 3, 'generation-a', 'source-a', '2026-01-01')`);

    await expect(
      db.execute(`insert into public_aggregate_counts
        (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
        values ('release_date_bucket', '12345', 1, 'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await db.execute(`insert into public_aggregate_membership
      (track_id, release_date_bucket, key_bucket, generation, source_version, updated_at)
      values ('track:null', null, null, 'generation-a', 'source-a', '2026-01-01'),
             ('track:empty', '', '', 'generation-a', 'source-a', '2026-01-01'),
             ('track:malformed', '20x?', 'wat', 'generation-a', 'source-a', '2026-01-01')`);

    await expect(
      db.execute(`insert into public_aggregate_membership
        (track_id, release_date_bucket, key_bucket, generation, source_version, updated_at)
        values ('track:long', '12345', null,
                'generation-a', 'source-a', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db.execute(`insert into projection_repairs
        (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
        values ('public_aggregates', 'label', 'label:a', 1, 'source-a',
                '2026-01-01', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);
  });

  it("keeps crawl fanout repairs separate, constrained, and epoch-ordered", async () => {
    const indexes = await db.execute(
      `select name, sql from sqlite_master
       where type = 'index' and tbl_name = 'crawl_projection_repairs'
       order by name`,
    );

    expect(indexes.rows.map((row) => row.name)).toEqual([
      "crawl_projection_repairs_order_idx",
      "sqlite_autoindex_crawl_projection_repairs_1",
    ]);
    expect(
      indexes.rows.find((row) => row.name === "crawl_projection_repairs_order_idx")?.sql,
    ).toContain("`source_epoch`,`source_type`,`source_id`");

    await db.execute(`insert into crawl_projection_repairs
      (source_type, source_id, source_epoch, source_version, created_at, updated_at)
      values ('label', 'label:a', 1, 'source-a', '2026-01-01', '2026-01-01'),
             ('artist', 'artist:a', 2, 'source-b', '2026-01-01', '2026-01-01')`);

    await expect(
      db.execute(`insert into crawl_projection_repairs
        (source_type, source_id, source_epoch, source_version, created_at, updated_at)
        values ('track', 'track:a', 3, 'source-c', '2026-01-01', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db.execute(`insert into crawl_projection_repairs
        (source_type, source_id, source_epoch, source_version, created_at, updated_at)
        values ('label', 'label:negative', -1, 'source-c', '2026-01-01', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);
  });

  it("persists a monotonic artifact sequence with vector-capable immutable payload rows", async () => {
    const table = await db.execute(
      `select sql from sqlite_master where type = 'table' and name = 'artifact_changes'`,
    );
    const rawDdl = table.rows[0]?.sql;
    const ddl = typeof rawDdl === "string" ? rawDdl : "";

    expect(ddl).toContain("PRIMARY KEY AUTOINCREMENT");
    expect(ddl).toContain("F32_BLOB(1024)");

    await db.execute(`insert into artifact_changes
      (created_at, format_version, operation, payload_json, producer, revision,
       stream, stream_version, subject_id, subject_type)
      values ('2026-01-01', 1, 'upsert', '{"id":"track:a"}', 'test', 1,
              'sonar.track', 1, 'track:a', 'track')`);
    await db.execute(`insert into artifact_changes
      (created_at, format_version, operation, payload_json, producer, revision,
       stream, stream_version, subject_id, subject_type)
      values ('2026-01-02', 1, 'delete', '{"id":"track:a"}', 'test', 2,
              'sonar.track', 1, 'track:a', 'track')`);

    const events = await db.execute("select seq, operation from artifact_changes order by seq");

    expect(events.rows).toEqual([
      { operation: "upsert", seq: 1 },
      { operation: "delete", seq: 2 },
    ]);
    await expect(
      db.execute(`insert into artifact_changes
        (created_at, format_version, operation, payload_json, producer, revision,
         stream, stream_version, subject_id, subject_type)
        values ('2026-01-03', 1, 'upsert', '{}', 'retry', 2,
                'sonar.track', 1, 'track:a', 'track')`),
    ).rejects.toThrow(/unique/i);
  });

  it("makes every active consumer a checkpoint barrier and clears inactive resume state", async () => {
    await db.execute(`insert into artifact_change_consumers
      (consumer_id, registered_at, state, state_changed_at, updated_at)
      values ('inactive-a', '2026-01-01', 'inactive', '2026-01-01', '2026-01-01')`);

    await expect(
      db.execute(`insert into artifact_change_consumers
        (consumer_id, registered_at, snapshot_seq, state, state_changed_at, updated_at)
        values ('inactive-bad', '2026-01-01', 7, 'inactive', '2026-01-01', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db.execute(`insert into artifact_change_consumers
        (consumer_id, registered_at, snapshot_seq, applied_through_seq, checkpointed_at,
         state, state_changed_at, updated_at)
        values ('active-bad', '2026-01-01', 8, 7, '2026-01-01',
                'active', '2026-01-01', '2026-01-01')`),
    ).rejects.toThrow(/constraint/i);

    await db.execute(`insert into artifact_change_consumers
      (consumer_id, registered_at, snapshot_seq, applied_through_seq, checkpointed_at,
       state, state_changed_at, updated_at)
      values ('active-a', '2026-01-01', 3, 5, '2026-01-01',
              'active', '2026-01-01', '2026-01-01'),
             ('active-b', '2026-01-01', 4, 9, '2026-01-01',
              'active', '2026-01-01', '2026-01-01')`);

    const barrier = await db.execute(
      `select min(applied_through_seq) as seq
       from artifact_change_consumers
       where state = 'active'`,
    );

    expect(barrier.rows[0]?.seq).toBe(5);
  });
});
