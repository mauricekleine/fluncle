import { type Client, type InValue } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";

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
        sql: `select artist_id, generation, track_id, updated_at
          from artist_qualification_contributions
          where (track_id, artist_id) > (?, ?) order by track_id, artist_id limit ?`,
      },
      {
        args: ["", 10],
        sql: `select artist_id, generation, updated_at from artist_qualification
          where artist_id > ? order by artist_id limit ?`,
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
});
