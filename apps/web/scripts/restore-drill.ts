#!/usr/bin/env bun
/**
 * THE RESTORE DRILL — the backup's acceptance test.
 *
 * A backup that has never restored is a hope, not a backup. This drill takes a
 * dump artifact (`.sql` or `.sql.gz`) produced by the on-box backup sweep (or by
 * `db:pull-prod`), restores it into a THROWAWAY scratch libSQL database, and
 * verifies its integrity against the manifest captured at dump time:
 *
 *   - table count matches,
 *   - every table's row count matches,
 *   - the anchor table's content spot-check (count + min/max of its first column)
 *     matches — proving actual values survived, not just row counts.
 *
 * Exits 0 on a clean restore, non-zero (loudly) on any mismatch. Nothing here
 * touches production or the dev database — it builds a scratch db under the OS temp
 * dir and deletes it. The comparison logic is the shared, unit-tested
 * `verifyManifest` from src/lib/server/db-dump.ts.
 *
 * Usage:
 *   bun run scripts/restore-drill.ts <dump.sql.gz> [manifest.json]
 *
 * The manifest defaults to the dump's sibling `manifest.json` (or `<name>.manifest.json`).
 */
import { createClient } from "@libsql/client";
import { gunzipSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { type DumpManifest, type ManifestCheck } from "../src/lib/server/db-dump";

import { quoteIdent, spotCell, verifyManifest } from "../src/lib/server/db-dump";

function fail(message: string): never {
  console.error(`restore-drill: ${message}`);
  process.exit(1);
}

const [dumpPath, manifestArg] = process.argv.slice(2);

if (!dumpPath) {
  fail("usage: bun run scripts/restore-drill.ts <dump.sql.gz> [manifest.json]");
}

if (!existsSync(dumpPath)) {
  fail(`dump not found: ${dumpPath}`);
}

// Resolve the manifest: explicit arg, else a sibling manifest.json, else <name>.manifest.json.
function resolveManifestPath(): string {
  if (manifestArg) {
    return manifestArg;
  }

  const sibling = join(dirname(dumpPath), "manifest.json");
  if (existsSync(sibling)) {
    return sibling;
  }

  const named = join(
    dirname(dumpPath),
    `${basename(dumpPath).replace(/\.sql(\.gz)?$/, "")}.manifest.json`,
  );
  if (existsSync(named)) {
    return named;
  }

  return sibling;
}

const manifestPath = resolveManifestPath();

if (!existsSync(manifestPath)) {
  fail(`manifest not found (looked at ${manifestPath}); pass it as the 2nd argument`);
}

const expected = JSON.parse(readFileSync(manifestPath, "utf8")) as DumpManifest;

// Decompress if gzipped; a plain .sql is read as-is.
const raw = readFileSync(dumpPath);
const sql = dumpPath.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");

const scratchDir = mkdtempSync(join(tmpdir(), "fluncle-restore-drill-"));
const scratchDb = join(scratchDir, "scratch.db");

async function main(): Promise<void> {
  const started = Date.now();
  const client = createClient({ url: `file:${scratchDb}` });

  // Restore the whole dump as one script (the same executeMultiple the app's client
  // speaks — proven to load the PRAGMA/BEGIN…COMMIT wrapper + blobs + escaped quotes).
  // A malformed/truncated dump throws here — report it as a clean restore failure
  // (the drill's whole point) instead of a raw stack trace.
  try {
    await client.executeMultiple(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify(
        { dump: dumpPath, ok: false, problems: [`restore failed: ${message}`] },
        null,
        2,
      ),
    );
    fail(`RESTORE FAILED — the dump did not load cleanly: ${message}`);
  }

  // Recompute the manifest shape against the restored database.
  const tableRows = await client.execute(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'
       AND name NOT LIKE '_litestream%'
     ORDER BY name`,
  );

  const tables: Record<string, number> = {};
  for (const row of tableRows.rows) {
    const name = row.name as string;
    const count = await client.execute(`SELECT count(*) AS c FROM ${quoteIdent(name)}`);
    tables[name] = Number(count.rows[0]?.c);
  }

  let spot: ManifestCheck["spot"] = null;
  if (expected.spot) {
    const { column, table } = expected.spot;
    const result = await client.execute(
      `SELECT count(*) AS c, min(${quoteIdent(column)}) AS mn, max(${quoteIdent(column)}) AS mx
       FROM ${quoteIdent(table)}`,
    );
    const spotRow = result.rows[0];
    spot = {
      column,
      count: Number(spotRow?.c),
      max: spotCell(spotRow?.mx),
      min: spotCell(spotRow?.mn),
      table,
    };
  }

  const actual: ManifestCheck = { spot, tableCount: tableRows.rows.length, tables };
  const report = verifyManifest(expected, actual);
  const elapsed = Date.now() - started;

  const totalRows = Object.values(tables).reduce((sum, count) => sum + count, 0);
  console.log(
    JSON.stringify(
      {
        actualRows: totalRows,
        actualTables: actual.tableCount,
        dump: dumpPath,
        elapsedMs: elapsed,
        expectedGeneratedAt: expected.generatedAt,
        expectedSource: expected.source,
        expectedTables: expected.tableCount,
        ok: report.ok,
        problems: report.problems,
        spot: expected.spot
          ? `${expected.spot.table}.${expected.spot.column} count=${expected.spot.count}`
          : null,
      },
      null,
      2,
    ),
  );

  if (!report.ok) {
    fail(`RESTORE VERIFICATION FAILED (${report.problems.length} problem(s)) — see above`);
  }

  console.log(
    `restore-drill: OK — ${actual.tableCount} tables, ${totalRows} rows restored + verified against the manifest in ${elapsed}ms.`,
  );
}

try {
  await main();
} finally {
  rmSync(scratchDir, { force: true, recursive: true });
}
