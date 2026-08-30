import { type Client, type InStatement, type InValue } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";
import {
  type PublicProjectionClient,
  readPublicProjectionAuditChunk,
  trackAnchorSourcePageQuery,
} from "./public-projections";

describe("bounded projection cleanup plans", () => {
  let db: Client;

  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  afterEach(() => db.close());

  it("seeks each cleanup phase through its persisted ordered coordinate", async () => {
    const pages: { args: InValue[]; sql: string }[] = [
      {
        args: ["finding.note", "track", "", 10],
        sql: `select generation, state, subject_id, updated_at from due_work
          where work_kind = ? and subject_type = ? and subject_id > ?
          order by subject_id limit ?`,
      },
      {
        args: ["", 10],
        sql: `select generation, node_id, state, updated_at from crawl_due_work
          where node_id > ? order by node_id limit ?`,
      },
      {
        args: ["", 10],
        sql: `select generation, track_id, updated_at from public_aggregate_membership
          where track_id > ? order by track_id limit ?`,
      },
      {
        args: ["", "", 10],
        sql: `select artist_id, generation, track_id, updated_at,
          not exists (select 1 from tracks source where source.track_id = contribution.track_id)
            as source_missing
          from artist_qualification_contributions contribution
          where (track_id, artist_id) > (?, ?) order by track_id, artist_id limit ?`,
      },
      {
        args: ["", 10],
        sql: `select artist_id, generation, updated_at from artist_qualification
          where artist_id > ? order by artist_id limit ?`,
      },
      {
        args: ["artist-a", "artist-b"],
        sql: `select contribution.artist_id,
          sum(contribution.certified_contribution) as certified_finding_count,
          sum(contribution.enabled_credit_half_units) as enabled_credit_half_units
          from artist_qualification_contributions contribution
          where contribution.artist_id in (?, ?)
          group by contribution.artist_id`,
      },
      {
        args: ["tracks", "all:", "all:\uffff", "all:", 10],
        sql: `select clause_hash from hub_page_anchors
          where hub = ? and clause_hash >= ? and clause_hash < ? and clause_hash > ?
          order by clause_hash limit ?`,
      },
    ];

    for (const page of pages) {
      expect(page.sql).not.toMatch(/generation\s*(?:<>|!=)/i);
      const detail = (
        await db.execute({ args: page.args, sql: `explain query plan ${page.sql}` })
      ).rows
        .flatMap((row) => (typeof row.detail === "string" ? [row.detail] : []))
        .join("\n");
      expect(detail).toMatch(/SEARCH .* USING (?:COVERING )?INDEX/i);
      expect(detail).not.toContain("SCAN ");
      expect(detail).not.toContain("USE TEMP B-TREE");
    }
  });

  it("uses an indexed SEARCH for every initial and resumed anchor source phase", async () => {
    const queries = [
      trackAnchorSourcePageQuery({ id: null, key: null, phase: "non_null" }, 10),
      trackAnchorSourcePageQuery({ id: "dated-b", key: "2026-01-01", phase: "non_null" }, 10),
      trackAnchorSourcePageQuery({ id: null, key: null, phase: "null" }, 10),
      trackAnchorSourcePageQuery({ id: "null-b", key: null, phase: "null" }, 10),
    ];

    for (const query of queries) {
      expect(query.sql.toLowerCase()).not.toContain(" or ");
      const detail = (
        await db.execute({ args: query.args, sql: `explain query plan ${query.sql}` })
      ).rows
        .flatMap((row) => (typeof row.detail === "string" ? [row.detail] : []))
        .join("\n");
      expect(detail).toContain(
        "SEARCH tracks USING COVERING INDEX tracks_release_date_track_id_idx",
      );
      expect(detail).not.toContain("SCAN ");
      expect(detail).not.toContain("USE TEMP B-TREE");
    }
  });

  it("keyset-pages the artist contribution source audit through its ordered primary key", async () => {
    const statements: Array<Exclude<InStatement, string>> = [];
    const traced: PublicProjectionClient = {
      batch: db.batch.bind(db),
      execute: async (statement) => {
        if (typeof statement === "string") {
          return db.execute(statement);
        }
        statements.push(statement);
        return db.execute(statement);
      },
    };

    await readPublicProjectionAuditChunk(traced, "artist_source_contributions", {
      cursor: null,
      limit: 10,
    });
    await readPublicProjectionAuditChunk(traced, "artist_source_contributions", {
      cursor: JSON.stringify(["track-a", "artist-a"]),
      limit: 10,
    });

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const args = statement.args;
      if (!Array.isArray(args)) {
        throw new Error("artist contribution audit query must use positional arguments");
      }
      expect(statement.sql).toContain("where (ta.track_id, ta.artist_id) > (?, ?)");
      expect(statement.sql).toContain("order by ta.track_id, ta.artist_id limit ?");
      expect(args.at(-1)).toBe(10);
      const detail = (await db.execute({ args, sql: `explain query plan ${statement.sql}` })).rows
        .flatMap((row) => (typeof row.detail === "string" ? [row.detail] : []))
        .join("\n");
      expect(detail).toMatch(
        /SEARCH ta USING (?:COVERING )?INDEX sqlite_autoindex_track_artists_1 \(\(track_id,artist_id\)>\(\?,\?\)\)/,
      );
      expect(detail).not.toContain("SCAN ");
      expect(detail).not.toContain("USE TEMP B-TREE");
    }
  });

  it("keyset-pages artist rollups over every credited artist through the edge index", async () => {
    const statements: Array<Exclude<InStatement, string>> = [];
    const traced: PublicProjectionClient = {
      batch: db.batch.bind(db),
      execute: async (statement) => {
        if (typeof statement === "string") {
          return db.execute(statement);
        }
        statements.push(statement);
        return db.execute(statement);
      },
    };

    await readPublicProjectionAuditChunk(traced, "artist_source_rollups", {
      cursor: null,
      limit: 10,
    });
    await readPublicProjectionAuditChunk(traced, "artist_source_rollups", {
      cursor: "artist-a",
      limit: 10,
    });

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const args = statement.args;
      if (!Array.isArray(args)) {
        throw new Error("artist rollup audit query must use positional arguments");
      }
      expect(statement.sql).toContain("track_artists indexed by track_artists_artist_id_idx");
      expect(statement.sql).toContain("where artist_id > ? order by artist_id limit ?");
      expect(args.at(-1)).toBe(10);
      const detail = (await db.execute({ args, sql: `explain query plan ${statement.sql}` })).rows
        .flatMap((row) => (typeof row.detail === "string" ? [row.detail] : []))
        .join("\n");
      expect(detail).toContain("track_artists_artist_id_idx (artist_id>?)");
      expect(detail).not.toMatch(/SCAN track_artists/);
    }
  });
});
