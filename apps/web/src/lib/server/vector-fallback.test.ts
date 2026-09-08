import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { describe, expect, it } from "vitest";
import {
  executeVectorFallback,
  VECTOR_FALLBACK_CANDIDATE_LIMIT,
  VECTOR_FALLBACK_DEADLINE_MS,
  VECTOR_FALLBACK_OPERATION_IDS,
  vectorFallbackCandidateLimitSql,
} from "./vector-fallback";

describe("Sonar's Turso fallback cost contract", () => {
  const consumers = [
    {
      file: "track-page.ts",
      name: "track page",
      operationIds: ["sonar.fallback.track"],
    },
    { file: "tracks.ts", name: "log", operationIds: ["sonar.fallback.log"] },
    { file: "search.ts", name: "sonic search", operationIds: ["sonar.fallback.search"] },
    {
      file: "recommendations.ts",
      name: "recommendations",
      operationIds: [
        "sonar.fallback.recommendations-catalogue",
        "sonar.fallback.recommendations-findings",
      ],
    },
  ] as const;

  it("cuts a real candidate relation at the configured bound", async () => {
    const db = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    await db.execute("create table candidates (id text primary key, embedding_blob F32_BLOB(2))");
    await db.batch(
      [
        { id: "a", vector: "[0, 1]" },
        { id: "b", vector: "[0.1, 0.9]" },
        // The perfect match is outside the two-id candidate window. If the limit were applied
        // after cosine ranking, this row would win and the assertion below would fail.
        { id: "c", vector: "[1, 0]" },
      ].map(({ id, vector }) => ({
        args: [id, vector],
        sql: "insert into candidates(id, embedding_blob) values(?, vector32(?))",
      })),
      "write",
    );

    const result = await executeVectorFallback(
      db,
      "sonar.fallback.search",
      {
        args: [],
        sql: `with bounded_ids(id) as materialized (
          select id from candidates where embedding_blob is not null order by id
          ${vectorFallbackCandidateLimitSql(2)}
        ) select bounded_ids.id from bounded_ids
          join candidates on candidates.id = bounded_ids.id
          order by vector_distance_cos(candidates.embedding_blob, vector32('[1, 0]')), bounded_ids.id`,
      },
      { candidateLimit: 2 },
    );

    expect(result.rows.map((row) => row.id)).toEqual(["b", "a"]);
    db.close();
  });

  it("keeps embedding membership ahead of the ID-only cap", async () => {
    const db = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    await db.execute("create table candidates (id text primary key, embedding_blob F32_BLOB(2))");
    await db.execute({ args: ["a"], sql: "insert into candidates(id) values(?)" });
    await db.batch(
      ["b", "c"].map((id, index) => ({
        args: [id, index === 0 ? "[0, 1]" : "[1, 0]"],
        sql: "insert into candidates(id, embedding_blob) values(?, vector32(?))",
      })),
      "write",
    );

    const result = await db.execute(`with bounded_ids(id) as materialized (
      select id from candidates where embedding_blob is not null order by id
      ${vectorFallbackCandidateLimitSql(2)}
    ) select bounded_ids.id from bounded_ids
      join candidates on candidates.id = bounded_ids.id
      order by bounded_ids.id`);

    expect(result.rows.map((row) => row.id)).toEqual(["b", "c"]);
    db.close();
  });

  it("refuses a fallback statement that omitted its candidate bound", async () => {
    const db = { execute: () => Promise.resolve({ rows: [] }) };

    await expect(
      executeVectorFallback(db as never, "sonar.fallback.track", "select 1"),
    ).rejects.toThrow(`${VECTOR_FALLBACK_CANDIDATE_LIMIT}-row candidate bound`);
  });

  it("fires the shared absolute deadline", async () => {
    const never = new Promise<never>(() => undefined);
    const db = { execute: () => never };

    await expect(
      executeVectorFallback(
        db as never,
        "sonar.fallback.log",
        `select 1 ${vectorFallbackCandidateLimitSql()}`,
        { deadlineMs: 10 },
      ),
    ).rejects.toThrow("sonar.fallback.log timed out after 10ms");
    expect(VECTOR_FALLBACK_DEADLINE_MS).toBe(12_000);
  });

  it("attaches the existing operation_id and heavy-read access_class vocabulary", async () => {
    let observed: unknown;
    const db = {
      execute: (statement: unknown) => {
        observed = statement;
        return Promise.resolve({ rows: [] });
      },
    };

    await executeVectorFallback(
      db as never,
      "sonar.fallback.recommendations-catalogue",
      `select 1 ${vectorFallbackCandidateLimitSql()}`,
    );

    expect(observed).toBeTypeOf("object");
    const symbols = Object.getOwnPropertySymbols(observed as object);

    expect(symbols).toHaveLength(1);
    expect((observed as Record<symbol, unknown>)[symbols[0] as symbol]).toEqual({
      accessClass: "heavy-read",
      operationId: "sonar.fallback.recommendations-catalogue",
    });
  });

  it("keeps every Sonar-null vector fallback on the shared executor", () => {
    const sources = [
      "artist-dossier.ts",
      "recommendations.ts",
      "search.ts",
      "track-page.ts",
      "tracks.ts",
    ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
    const joined = sources.join("\n");

    for (const operationId of VECTOR_FALLBACK_OPERATION_IDS) {
      expect(joined, operationId).toContain(`"${operationId}"`);
    }

    expect(joined.match(/executeVectorFallback\(/g)).toHaveLength(
      VECTOR_FALLBACK_OPERATION_IDS.length,
    );
  });

  it("enumerates every route consumer under a candidate bound, deadline, and cost span", async () => {
    expect(consumers.map((consumer) => consumer.name)).toEqual([
      "track page",
      "log",
      "sonic search",
      "recommendations",
    ]);

    for (const consumer of consumers) {
      const source = readFileSync(new URL(consumer.file, import.meta.url), "utf8");

      for (const operationId of consumer.operationIds) {
        expect(source, `${consumer.name}: ${operationId}`).toMatch(
          new RegExp(`executeVectorFallback\\(\\s*db,\\s*"${operationId}"`),
        );
        expect(source, `${consumer.name}: ${operationId}`).toContain(
          "vectorFallbackCandidateLimitSql()",
        );

        await expect(
          executeVectorFallback(
            { execute: async () => ({ rows: [] }) } as never,
            operationId,
            "select 1",
          ),
        ).rejects.toThrow(`${VECTOR_FALLBACK_CANDIDATE_LIMIT}-row candidate bound`);

        await expect(
          executeVectorFallback(
            { execute: () => new Promise<never>(() => undefined) } as never,
            operationId,
            `select 1 ${vectorFallbackCandidateLimitSql()}`,
            { deadlineMs: 1 },
          ),
        ).rejects.toThrow(`${operationId} timed out after 1ms`);

        let observed: unknown;
        await executeVectorFallback(
          {
            execute: (statement: unknown) => {
              observed = statement;
              return Promise.resolve({ rows: [] });
            },
          } as never,
          operationId,
          `select 1 ${vectorFallbackCandidateLimitSql()}`,
        );
        const symbols = Object.getOwnPropertySymbols(observed as object);

        expect((observed as Record<symbol, unknown>)[symbols[0] as symbol]).toEqual({
          accessClass: "heavy-read",
          operationId,
        });
      }
    }
  });
});
