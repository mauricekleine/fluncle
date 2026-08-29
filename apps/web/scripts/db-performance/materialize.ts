#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Client, createClient } from "@libsql/client";

import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import {
  PERFORMANCE_FIXTURE_SCHEMA,
  applyFixtureSchema,
  auditFixtureCardinality,
  writeFixture,
} from "./fixture";
import {
  type FixtureCounts,
  type ScaleProfile,
  getScaleManifest,
  isScaleProfile,
} from "./manifest";
import { isPerformanceTimeoutError } from "./registry";

export const MATERIALIZED_FIXTURE_DATABASE_FILE = "fixture.sqlite3";
export const MATERIALIZED_FIXTURE_MANIFEST_FILE = "fixture-manifest.json";
/** Bump when generated row or distribution semantics change, even if schema and counts do not. */
export const PERFORMANCE_FIXTURE_FORMAT_VERSION = 2;

export type PerformanceFixtureIdentity = {
  canonicalCountsSha256: string;
  formatVersion: number;
  integrationBase: string;
  profile: ScaleProfile;
  schemaSha256: string;
};

export type MaterializedFixtureManifest = {
  database: { bytes: number; file: string; sha256: string };
  identity: PerformanceFixtureIdentity;
  quickCheck: "ok";
};

type MaterializeOptions = {
  /** A test-only compact derivative; the CLI always omits it and therefore writes exact counts. */
  counts?: FixtureCounts;
  outputDir: string;
  profile: ScaleProfile;
  repoRoot?: string;
};

type MaterializeDependencies = {
  write?: typeof writeFixture;
};

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fixtureCountsSha256(counts: FixtureCounts): string {
  return sha256Text(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );
}

export function fixtureSchemaSha256(): string {
  return sha256Text(JSON.stringify(PERFORMANCE_FIXTURE_SCHEMA));
}

export function expectedFixtureIdentity(
  profile: ScaleProfile,
  counts: FixtureCounts = getScaleManifest(profile).counts,
): PerformanceFixtureIdentity {
  return {
    canonicalCountsSha256: fixtureCountsSha256(counts),
    formatVersion: PERFORMANCE_FIXTURE_FORMAT_VERSION,
    integrationBase: getScaleManifest(profile).integrationBase,
    profile,
    schemaSha256: fixtureSchemaSha256(),
  };
}

export async function writeFixtureIdentity(
  client: Client,
  identity: PerformanceFixtureIdentity,
): Promise<void> {
  await client.batch(
    [
      {
        args: [],
        sql: `create table perf_fixture_identity (
          singleton integer primary key check (singleton = 1),
          format_version integer not null,
          profile text not null,
          integration_base text not null,
          canonical_counts_sha256 text not null,
          schema_sha256 text not null
        )`,
      },
      {
        args: [
          identity.formatVersion,
          identity.profile,
          identity.integrationBase,
          identity.canonicalCountsSha256,
          identity.schemaSha256,
        ],
        sql: `insert into perf_fixture_identity
          (singleton, format_version, profile, integration_base,
           canonical_counts_sha256, schema_sha256)
          values (1, ?, ?, ?, ?, ?)`,
      },
    ],
    "write",
  );
}

export async function verifyFixtureIdentity(
  client: Client,
  profile: ScaleProfile,
  counts: FixtureCounts = getScaleManifest(profile).counts,
): Promise<PerformanceFixtureIdentity> {
  let result;
  try {
    result = await client.execute(
      `select format_version, profile, integration_base, canonical_counts_sha256, schema_sha256
       from perf_fixture_identity where singleton = 1`,
    );
  } catch (error) {
    if (isPerformanceTimeoutError(error)) {
      const timeout = new Error("preseeded fixture identity request timed out");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw new Error("preseeded fixture identity is missing");
  }
  const row = result.rows[0];
  if (!row) {
    throw new Error("preseeded fixture identity is missing");
  }

  const observed: PerformanceFixtureIdentity = {
    canonicalCountsSha256:
      typeof row.canonical_counts_sha256 === "string" ? row.canonical_counts_sha256 : "",
    formatVersion: Number(row.format_version),
    integrationBase: typeof row.integration_base === "string" ? row.integration_base : "",
    profile: (typeof row.profile === "string" ? row.profile : "") as ScaleProfile,
    schemaSha256: typeof row.schema_sha256 === "string" ? row.schema_sha256 : "",
  };
  const expected = expectedFixtureIdentity(profile, counts);
  const mismatches = (Object.keys(expected) as (keyof PerformanceFixtureIdentity)[]).filter(
    (key) => observed[key] !== expected[key],
  );
  if (mismatches.length > 0) {
    throw new Error(`preseeded fixture identity mismatch: ${mismatches.join(", ")}`);
  }

  return observed;
}

async function assertQuickCheck(client: Client): Promise<"ok"> {
  const result = await client.execute("pragma quick_check");
  const row = result.rows[0];
  const value = row ? Object.values(row)[0] : undefined;
  if (result.rows.length !== 1 || value !== "ok") {
    const detail = typeof value === "string" ? value : value === undefined ? "missing" : "invalid";
    throw new Error(`materialized fixture quick_check failed: ${detail}`);
  }

  return "ok";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertNewOutsideRepoOutput(outputDir: string, repoRoot: string): Promise<void> {
  if (!isAbsolute(outputDir)) {
    throw new Error("materialized fixture output directory must be absolute");
  }
  const canonicalRepoRoot = await realpath(repoRoot);
  const canonicalOutputParent = await realpath(dirname(outputDir));
  const canonicalOutput = resolve(canonicalOutputParent, basename(outputDir));
  const relation = relative(canonicalRepoRoot, canonicalOutput);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("materialized fixture output directory must be outside the repository");
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function materializeFixture(
  options: MaterializeOptions,
  dependencies: MaterializeDependencies = {},
): Promise<MaterializedFixtureManifest> {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  await assertNewOutsideRepoOutput(options.outputDir, repoRoot);
  const outputDir = resolve(options.outputDir);
  if (await pathExists(outputDir)) {
    throw new Error("materialized fixture output directory already exists; refusing to overwrite");
  }

  let createdOutput = false;
  let client: Client | undefined;
  try {
    await mkdir(outputDir);
    createdOutput = true;
    const databasePath = resolve(outputDir, MATERIALIZED_FIXTURE_DATABASE_FILE);
    const counts = options.counts ?? getScaleManifest(options.profile).counts;
    client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: `file:${databasePath}` });
    await client.execute("pragma journal_mode = wal");
    await applyFixtureSchema(client);
    await (dependencies.write ?? writeFixture)(client, options.profile, { counts });
    const census = await auditFixtureCardinality(client, counts);
    if (!census.passed) {
      throw new Error(`materialized fixture census failed: ${census.mismatches.join("; ")}`);
    }
    await assertQuickCheck(client);
    const identity = expectedFixtureIdentity(options.profile, counts);
    await writeFixtureIdentity(client, identity);
    await verifyFixtureIdentity(client, options.profile, counts);
    const quickCheck = await assertQuickCheck(client);
    await client.execute("pragma wal_checkpoint(truncate)");
    await client.execute("pragma journal_mode = delete");
    client.close();
    client = undefined;

    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${databasePath}${suffix}`;
      if (await pathExists(sidecarPath)) {
        throw new Error(`materialized fixture retained forbidden SQLite ${suffix} residue`);
      }
    }

    const databaseStat = await stat(databasePath);
    const manifest: MaterializedFixtureManifest = {
      database: {
        bytes: databaseStat.size,
        file: MATERIALIZED_FIXTURE_DATABASE_FILE,
        sha256: await sha256File(databasePath),
      },
      identity,
      quickCheck,
    };
    await writeFile(
      resolve(outputDir, MATERIALIZED_FIXTURE_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );

    return manifest;
  } catch (error) {
    client?.close();
    if (createdOutput) {
      await rm(outputDir, { force: true, recursive: true });
    }
    throw error;
  }
}

export function parseMaterializeArguments(args: readonly string[]): {
  outputDir: string;
  profile: ScaleProfile;
} {
  let outputDir: string | undefined;
  let profile: ScaleProfile | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value || !isScaleProfile(value)) {
        throw new Error("--profile must be one of 1x, 2x, or 4x");
      }
      profile = value;
      index += 1;
    } else if (argument === "--output-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a new absolute directory");
      }
      outputDir = value;
      index += 1;
    } else {
      throw new Error(`unknown fixture materializer option: ${argument ?? "<missing>"}`);
    }
  }
  if (!profile || !outputDir) {
    throw new Error("fixture materializer requires --profile and --output-dir");
  }

  return { outputDir, profile };
}

async function main(): Promise<void> {
  const manifest = await materializeFixture(parseMaterializeArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
