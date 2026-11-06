import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { labelFold } from "@fluncle/contracts/util/galaxy-slug";
import { readMigrationFiles } from "drizzle-orm/migrator";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillLabelNameFolds } from "../../../scripts/backfill-label-name-folds";
import { readCrawlFoldLabelRows } from "./crawl-labels";
import { typedRows } from "./db";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { createIntegrationDb, seedLabel } from "./integration-db";

let db: Client;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "label-fold-"));
  db = await createIntegrationDb({ url: `file:${join(directory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();
  await rm(directory, { force: true, recursive: true });
});

const nameArbitrary = fc.oneof(
  fc.constantFrom(
    "Méd Schööl",
    "MED SCHOOL",
    "Ｍｅｄ School",
    "med-school",
    "İstanbul",
    "istanbul",
    "東京",
    "東京！",
    "Σ",
    "ς",
    "ﬃ",
    "①",
    "",
    "! — ",
  ),
  fc
    .array(
      fc.oneof(fc.integer({ max: 0xd7ff, min: 32 }), fc.integer({ max: 0x10ffff, min: 0xe000 })),
      { maxLength: 20 },
    )
    .map((points) => String.fromCodePoint(...points)),
);

const scenarioArbitrary = fc.record({
  labels: fc.array(fc.record({ name: nameArbitrary, persisted: fc.boolean() }), { maxLength: 25 }),
  queries: fc.array(nameArbitrary, { maxLength: 12 }),
});

async function wholeIndexOracle(
  client: Pick<Client, "execute">,
  keys: string[],
): Promise<unknown[]> {
  const whole = await client.execute("select id, name from labels");
  const index = new Map<string, Set<string>>();
  for (const row of typedRows<{ id: string; name: string }>(whole.rows)) {
    const key = labelFold(row.name);
    if (key) {
      const ids = index.get(key) ?? new Set<string>();
      ids.add(row.id);
      index.set(key, ids);
    }
  }
  const wanted = new Set(keys.filter(Boolean));
  const ids = [...wanted].flatMap((key) => [...(index.get(key) ?? [])]);
  if (ids.length === 0) {
    return [];
  }
  const result = await client.execute({
    args: [JSON.stringify(ids)],
    sql: `select id, name, slug, mb_label_id, seed_state, founding_date, rowid as label_rowid
          from labels where id in (select value from json_each(?)) order by rowid`,
  });
  return typedRows<{ name: string }>(result.rows).filter((row) => wanted.has(labelFold(row.name)));
}

describe("crawl label fold reads", () => {
  it("equals the whole-index oracle for Unicode names, collisions, null folds and transaction-local changes", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ labels, queries }) => {
        const transaction = await db.transaction("write");
        try {
          for (const [index, label] of labels.entries()) {
            await transaction.execute({
              args: [
                `label-${index}`,
                label.name,
                label.persisted ? labelFold(label.name) : null,
                `slug-${index}`,
                index % 2 === 0 ? "enabled" : "disabled",
              ],
              sql: `insert into labels (id, name, name_fold, slug, seed_state, created_at, updated_at)
                    values (?, ?, ?, ?, ?, 'fixture', 'fixture')`,
            });
          }
          const keys = [
            ...queries,
            ...labels.filter((_, index) => index % 2 === 0).map((label) => label.name),
          ].map(labelFold);
          expect(await readCrawlFoldLabelRows(keys, transaction)).toEqual(
            await wholeIndexOracle(transaction, keys),
          );
          await transaction.execute({
            args: ["Méd School", labelFold("Méd School")],
            sql: `insert into labels (id, name, name_fold, slug, created_at, updated_at)
                  values ('minted', ?, ?, 'minted', 'fixture', 'fixture')`,
          });
          await transaction.execute({
            args: ["東京", labelFold("東京")],
            sql: `update labels set name = ?, name_fold = ?, seed_state = 'enabled' where id = 'label-0'`,
          });
          const freshKeys = [...keys, labelFold("MED SCHOOL"), labelFold("東京！")];
          expect(await readCrawlFoldLabelRows(freshKeys, transaction)).toEqual(
            await wholeIndexOracle(transaction, freshKeys),
          );
          await transaction.execute("delete from labels where id = 'minted'");
          expect(await readCrawlFoldLabelRows(freshKeys, transaction)).toEqual(
            await wholeIndexOracle(transaction, freshKeys),
          );
        } finally {
          await transaction.rollback();
          transaction.close();
        }
      }),
      {
        examples: [
          [
            {
              labels: [
                { name: "Méd School", persisted: false },
                { name: "MED SCHOOL", persisted: true },
              ],
              queries: ["Ｍｅｄ School", "!"],
            },
          ],
          [{ labels: [], queries: [] }],
        ],
        numRuns: Number(process.env.LABEL_FOLD_ORACLE_RUNS ?? 30),
        seed: 52,
      },
    );
  });

  it.each([1, 10, 101])(
    "reads only matching rows for %i folds in a populated archive",
    async (count) => {
      await db.batch(
        Array.from({ length: 2_048 }, (_, index) => ({
          args: [`label-${index}`, `Label ${index}`, labelFold(`Label ${index}`), `label-${index}`],
          sql: `insert into labels (id, name, name_fold, slug, created_at, updated_at)
              values (?, ?, ?, ?, 'fixture', 'fixture')`,
        })),
        "write",
      );
      const reference = await db.execute("select id, name from labels");
      let rowsRead = 0;
      let bytesRead = 0;
      const statements: InStatement[] = [];
      const client = {
        execute: async (query: InStatement) => {
          statements.push(query);
          const result = await db.execute(query);
          rowsRead += result.rows.length;
          bytesRead += Buffer.byteLength(JSON.stringify(result.rows));
          return result;
        },
      };
      const keys = Array.from({ length: count }, (_, index) => labelFold(`LABEL ${index}`));
      const rows = await readCrawlFoldLabelRows([...keys, ...keys, "missing"], client);
      expect(rows.map((row) => row.id)).toEqual(
        Array.from({ length: count }, (_, index) => `label-${index}`),
      );
      expect(rowsRead).toBe(count);
      expect(bytesRead).toBeLessThan(240 * count);
      if (count === 1) {
        expect(bytesRead).toBeLessThan(Buffer.byteLength(JSON.stringify(reference.rows)) / 100);
      }
      const statement = statements.at(-1);
      if (statement === undefined) {
        throw new Error("fold lookup must execute a database statement");
      }
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = typeof statement === "string" ? [] : statement.args;
      const plan = await db.execute({ args, sql: `explain query plan ${sql}` });
      const details = typedRows<{ detail: string }>(plan.rows).map((row) => row.detail);
      expect(
        details.filter((detail) => /SEARCH labels USING INDEX labels_name_fold_idx/.test(detail)),
      ).toHaveLength(2);
      expect(details.some((detail) => /SCAN labels/.test(detail))).toBe(false);
    },
  );

  it("backfills in resumable pages without changing label identity or name", async () => {
    for (let index = 0; index < 205; index += 1) {
      await seedLabel(db, {
        id: `label-${index}`,
        name: index % 2 ? "Méd School" : "東京！",
        slug: `label-${index}`,
      });
    }
    await db.execute("update labels set name_fold = null");
    const before = await db.execute("select id, name, slug from labels order by rowid");
    let pages = 0;
    await expect(
      backfillLabelNameFolds({
        batch: async (statements, mode) => {
          pages += 1;
          if (pages === 2) {
            throw new Error("fixture interruption");
          }
          expect(statements.length).toBeLessThanOrEqual(100);
          return db.batch(statements, mode);
        },
        execute: db.execute.bind(db),
      }),
    ).rejects.toThrow("fixture interruption");
    expect(
      (await db.execute("select count(*) as n from labels where name_fold is null")).rows[0]?.n,
    ).toBe(105);
    expect(await backfillLabelNameFolds(db)).toBe(105);
    expect(await backfillLabelNameFolds(db)).toBe(0);
    expect((await db.execute("select id, name, slug from labels order by rowid")).rows).toEqual(
      before.rows,
    );
    const after = await db.execute("select name, name_fold from labels");
    expect(
      typedRows<{ name: string; name_fold: string }>(after.rows).every(
        (row) => row.name_fold === labelFold(row.name),
      ),
    ).toBe(true);
  });

  it("rechecks a concurrent name change before persisting its fold", async () => {
    await seedLabel(db, { id: "rename", name: "Before", slug: "rename" });
    await db.execute("update labels set name_fold = null");
    let renamed = false;
    expect(
      await backfillLabelNameFolds({
        batch: async (statements, mode) => {
          if (!renamed) {
            renamed = true;
            await db.execute("update labels set name = 'Méd School' where id = 'rename'");
          }
          return db.batch(statements, mode);
        },
        execute: db.execute.bind(db),
      }),
    ).toBe(1);
    expect(
      (await db.execute("select name, name_fold from labels where id = 'rename'")).rows,
    ).toEqual([{ name: "Méd School", name_fold: "medschool" }]);
  });

  it("applies the generated expansion to existing rows, keeps the old read usable and restores the pre-migration copy", async () => {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)),
    });
    const expansionIndex = 203;
    const expansion = migrations[expansionIndex];
    if (!expansion) {
      throw new Error("label fold migration is missing");
    }
    const originalFile = join(directory, "before.db");
    const migratedFile = join(directory, "migrated.db");
    const before = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: `file:${originalFile}` });
    let oldRows: unknown[];
    try {
      await before.migrate(
        migrations.slice(0, expansionIndex).flatMap((migration) => migration.sql),
      );
      await before.execute(`insert into labels (id, name, slug, created_at, updated_at)
        values ('a', 'Méd School', 'a', 'fixture', 'fixture'),
               ('b', 'MED SCHOOL', 'b', 'fixture', 'fixture'),
               ('c', '東京！', 'c', 'fixture', 'fixture')`);
      oldRows = (await before.execute("select id, name from labels")).rows;
    } finally {
      before.close();
    }
    await copyFile(originalFile, migratedFile);
    const migrated = createClient({
      concurrency: LOCAL_DB_CONCURRENCY,
      url: `file:${migratedFile}`,
    });
    try {
      await migrated.migrate(expansion.sql);
      expect(await backfillLabelNameFolds(migrated)).toBe(3);
      expect((await migrated.execute("select id, name from labels")).rows).toEqual(oldRows);
      expect((await readCrawlFoldLabelRows(["medschool"], migrated)).map((row) => row.id)).toEqual([
        "a",
        "b",
      ]);
    } finally {
      migrated.close();
    }
    const restoredFile = join(directory, "restored.db");
    await copyFile(originalFile, restoredFile);
    const restored = createClient({
      concurrency: LOCAL_DB_CONCURRENCY,
      url: `file:${restoredFile}`,
    });
    try {
      expect((await restored.execute("select id, name from labels")).rows).toEqual(oldRows);
      expect(
        (await restored.execute("pragma table_info(labels)")).rows.some(
          (row) => row.name === "name_fold",
        ),
      ).toBe(false);
    } finally {
      restored.close();
    }
  });
});
