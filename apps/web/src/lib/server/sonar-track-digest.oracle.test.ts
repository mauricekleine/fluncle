import { type Client, type InStatement, type Row } from "@libsql/client";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { snapshotMaterial } from "./artifact-changes";
import { buildSonarTrackDigestStatement, listSonarTrackDigests } from "./sonar-source-reads";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table tracks (track_id text primary key, key text, bpm real, spotify_uri text,
      dismissed_at text, duplicate_of_track_id text, nearest_finding_score real, duration_ms integer);
    create table track_embeddings (track_id text primary key, embedding_blob blob);
    create table findings (track_id text primary key, log_id text);
    create table artifact_change_revisions (stream text, stream_version integer, subject_type text,
      subject_id text, revision integer, primary key(stream, stream_version, subject_type, subject_id, revision));
  `);
  sqlite.function("crypto_sha256", (value) => {
    if (!(value instanceof Uint8Array)) {
      throw new Error("digest input must preserve binary framing");
    }
    return createHash("sha256").update(value).digest();
  });
  const client: Pick<Client, "execute"> = {
    async execute(input: InStatement) {
      const statement = typeof input === "string" ? { args: [], sql: input } : input;
      const query = sqlite.prepare(statement.sql);
      const rows = query.all(...((statement.args ?? []) as SQLInputValue[]));
      const columns = query.columns().map((column) => column.name);
      return {
        columnTypes: columns.map(() => ""),
        columns,
        lastInsertRowid: undefined,
        rows: rows as unknown as Row[],
        rowsAffected: 0,
        toJSON: () => ({ columns, rows }),
      };
    },
  };
  return { client, sqlite };
}

const nullableString = fc.option(fc.string({ maxLength: 18 }), { nil: null });
const nullableNumber = fc.option(
  fc.oneof(
    fc.double({ max: 1_000_000, min: -1_000_000, noDefaultInfinity: true, noNaN: true }),
    fc.constantFrom(0, -0, 2 ** 32, 170.125),
  ),
  { nil: null },
);
const rowArbitrary = fc.record({
  bpm: nullableNumber,
  dismissed: fc.boolean(),
  duplicate: fc.boolean(),
  duration: fc.option(fc.integer({ max: 2 ** 32, min: -1 }), { nil: null }),
  finding: fc.boolean(),
  key: nullableString,
  log: nullableString,
  score: nullableNumber,
  spotify: nullableString,
  vector: fc.option(fc.uint8Array({ maxLength: 4_096, minLength: 4_096 }), { nil: null }),
});
type Source = typeof rowArbitrary extends fc.Arbitrary<infer Value> ? Value : never;

const stableRow: Source = {
  bpm: 170.125,
  dismissed: false,
  duplicate: false,
  duration: 270_000,
  finding: true,
  key: 'A\u0000"雪\n',
  log: "1.A.AA",
  score: 0.987654321,
  spotify: "spotify:track:fixture",
  vector: new Uint8Array(4096),
};

function seed(sqlite: DatabaseSync, id: string, row: Source) {
  sqlite
    .prepare("insert into tracks values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      id,
      row.key,
      row.bpm,
      row.spotify,
      row.dismissed ? "dismissed" : null,
      row.duplicate ? "other" : null,
      row.score,
      row.duration,
    );
  if (row.finding) {
    sqlite.prepare("insert into findings values (?, ?)").run(id, row.log);
  }
  if (row.vector !== null) {
    sqlite.prepare("insert into track_embeddings values (?, ?)").run(id, row.vector);
  }
  sqlite
    .prepare("insert into artifact_change_revisions values ('sonar.track', 1, 'track', ?, 3)")
    .run(id);
  sqlite
    .prepare("insert into artifact_change_revisions values ('sonar.track', 1, 'track', ?, 1)")
    .run(id);
  sqlite
    .prepare("insert into artifact_change_revisions values ('sonar.track', 2, 'track', ?, 99)")
    .run(id);
}

async function reference(
  client: Pick<Client, "execute">,
  input: { after?: string; limit: number },
) {
  const items: { payloadDigest: string; revision: number; subjectId: string }[] = [];
  let after = input.after;
  while (items.length < input.limit) {
    const requested = Math.min(200, input.limit - items.length);
    const rows = (await client.execute(buildSonarTrackDigestStatement(after, requested))).rows;
    for (const row of rows.slice(0, requested)) {
      items.push({
        payloadDigest: (await snapshotMaterial("sonar.track", row)).payloadDigest,
        revision: Number(row.revision),
        subjectId: row.track_id as string,
      });
    }
    if (rows.length <= requested) {
      break;
    }
    after = items.at(-1)?.subjectId;
  }
  return {
    items,
    nextAfter: items.length === input.limit ? (items.at(-1)?.subjectId ?? null) : null,
  };
}

function serializedBytes(rows: Row[]) {
  return Buffer.byteLength(
    JSON.stringify(rows, (_key, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
    ),
  );
}

describe("Sonar digest read equivalence", () => {
  it("matches the old read for every source payload and exclusive cursor", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(rowArbitrary, { maxLength: 10 }),
        fc.integer({ max: 12, min: 0 }),
        fc.integer({ max: 12, min: 1 }),
        async (rows, cursor, limit) => {
          const { client, sqlite } = fixture();
          try {
            rows.forEach((row, index) =>
              seed(sqlite, `track:${index.toString().padStart(3, "0")}雪`, row),
            );
            const after =
              cursor === 0 ? undefined : `track:${(cursor - 1).toString().padStart(3, "0")}雪`;
            const input = { after, limit };
            expect(await listSonarTrackDigests(client, input)).toEqual(
              await reference(client, input),
            );
          } finally {
            sqlite.close();
          }
        },
      ),
      {
        examples: [
          [
            [
              {
                bpm: null,
                dismissed: false,
                duplicate: false,
                duration: null,
                finding: false,
                key: null,
                log: null,
                score: null,
                spotify: null,
                vector: new Uint8Array(4096),
              },
            ],
            0,
            1,
          ],
        ],
        numRuns: Number(process.env.SONAR_DIGEST_ORACLE_RUNS ?? 50),
        seed: 52,
      },
    );
  });

  it.each([
    "update tracks set key = 'changed' where track_id = 'track:001'",
    "update tracks set bpm = 174.25 where track_id = 'track:001'",
    "update tracks set spotify_uri = null where track_id = 'track:001'",
    "update tracks set dismissed_at = 'dismissed' where track_id = 'track:001'",
    "update tracks set duplicate_of_track_id = 'other' where track_id = 'track:001'",
    "update tracks set nearest_finding_score = 0.75 where track_id = 'track:001'",
    "update tracks set duration_ms = 200000 where track_id = 'track:001'",
    "update findings set log_id = null where track_id = 'track:001'",
    "delete from findings where track_id = 'track:001'",
    "update track_embeddings set embedding_blob = randomblob(4096) where track_id = 'track:001'",
    "delete from track_embeddings where track_id = 'track:001'",
    "update track_embeddings set embedding_blob = x'00' where track_id = 'track:001'",
    "delete from tracks where track_id = 'track:001'",
    "insert into artifact_change_revisions values ('sonar.track', 1, 'track', 'track:001', 4)",
  ])("uses current source material when a write races the header read: %s", async (mutation) => {
    const { client, sqlite } = fixture();
    try {
      const row = stableRow;
      seed(sqlite, "track:001", {
        ...row,
        finding: true,
        log: "1.A.AA",
        spotify: "spotify",
        vector: new Uint8Array(4096),
      });
      seed(sqlite, "track:003", { ...row, vector: new Uint8Array(4096) });
      const input = { limit: 1 };
      let expected: Awaited<ReturnType<typeof reference>> | undefined;
      const racing: Pick<Client, "execute"> = {
        async execute(statement: InStatement) {
          if (typeof statement !== "string" && statement.sql.startsWith("with headers")) {
            sqlite.exec(mutation);
            seed(sqlite, "track:002", { ...row, vector: new Uint8Array(4096) });
            expected = await reference(client, input);
          }
          return client.execute(statement);
        },
      };
      const actual = await listSonarTrackDigests(racing, input);
      expect(expected).toBeDefined();
      expect(actual).toEqual(expected);
    } finally {
      sqlite.close();
    }
  });

  it("keeps page boundaries while transferring no vector bytes for stable rows", async () => {
    const { client, sqlite } = fixture();
    try {
      const row = stableRow;
      for (let index = 0; index < 401; index++) {
        seed(sqlite, `track:${index.toString().padStart(3, "0")}`, {
          ...row,
          vector: new Uint8Array(4096).fill(index % 256),
        });
      }
      for (const limit of [1, 199, 200, 201, 400, 401, 402, 2000]) {
        const input = { limit };
        expect(await listSonarTrackDigests(client, input)).toEqual(await reference(client, input));
      }
      let transferred = 0;
      let vectorBytes = 0;
      const measured: Pick<Client, "execute"> = {
        async execute(statement: InStatement) {
          const result = await client.execute(statement);
          transferred += serializedBytes(result.rows);
          for (const row of result.rows) {
            if (row.embedding_blob instanceof Uint8Array) {
              vectorBytes += row.embedding_blob.byteLength;
            }
          }
          return result;
        },
      };
      const old = await client.execute(buildSonarTrackDigestStatement(undefined, 200));
      await listSonarTrackDigests(measured, { limit: 200 });
      expect(vectorBytes).toBe(0);
      expect(transferred).toBeLessThan(serializedBytes(old.rows) / 4);
      console.log(
        JSON.stringify({ after: transferred, before: serializedBytes(old.rows), vectorBytes }),
      );
    } finally {
      sqlite.close();
    }
  });

  it("leaves invalid lookahead material unconsumed", async () => {
    const { client, sqlite } = fixture();
    try {
      seed(sqlite, "track:a", stableRow);
      seed(sqlite, "track:b", { ...stableRow, bpm: 1e300 });
      expect(await listSonarTrackDigests(client, { limit: 1 })).toEqual(
        await reference(client, { limit: 1 }),
      );
    } finally {
      sqlite.close();
    }
  });

  it("rejects text posing as a vector just like the snapshot read", async () => {
    const { client, sqlite } = fixture();
    try {
      seed(sqlite, "track:a", stableRow);
      sqlite.prepare("update track_embeddings set embedding_blob = ?").run("x".repeat(4096));
      await expect(reference(client, { limit: 1 })).rejects.toThrow("has no vector blob");
      await expect(listSonarTrackDigests(client, { limit: 1 })).rejects.toThrow(
        "has no vector blob",
      );
    } finally {
      sqlite.close();
    }
  });

  it("propagates SQL failures other than an unavailable hash extension", async () => {
    const { client, sqlite } = fixture();
    try {
      const row = stableRow;
      seed(sqlite, "track:a", { ...row, vector: new Uint8Array(4096) });
      sqlite.function("crypto_sha256", (_value) => {
        throw new Error("hash failed");
      });
      await expect(listSonarTrackDigests(client, { limit: 1 })).rejects.toThrow("hash failed");
    } finally {
      sqlite.close();
    }
  });
});
