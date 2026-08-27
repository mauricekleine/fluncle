import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { createClient as createLocalClient } from "@libsql/client";

import { LOCAL_DB_CONCURRENCY, REMOTE_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { performanceRegistry, selectPerformanceContracts } from "./contracts";
import { applyFixtureSchema, resetFixture, writeFixture } from "./fixture";
import { resolveHostedReplay } from "./hosted";
import {
  type ScaleProfile,
  createCiFixtureCounts,
  getScaleManifest,
  isScaleProfile,
} from "./manifest";
import {
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  fixtureBaselineAdjustedResourceSample,
  maxPerformanceResourceSample,
  readPerformanceResourceSample,
  runPerformanceContracts,
} from "./registry";

type CliOptions = {
  contractIds: string[];
  fullFixture: boolean;
  hosted: boolean;
  list: boolean;
  operatorApproved: boolean;
  profile: ScaleProfile;
};

function parseArguments(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    contractIds: [],
    fullFixture: false,
    hosted: false,
    list: false,
    operatorApproved: false,
    profile: "1x",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--hosted") {
      options.hosted = true;
    } else if (argument === "--operator-approved") {
      options.operatorApproved = true;
    } else if (argument === "--full-fixture") {
      options.fullFixture = true;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--profile") {
      const profile = args[index + 1];
      if (!profile || !isScaleProfile(profile)) {
        throw new Error("--profile must be one of 1x, 2x, or 4x");
      }
      options.profile = profile;
      index += 1;
    } else if (argument === "--contract") {
      const contractId = args[index + 1];
      if (!contractId) {
        throw new Error("--contract requires a registered contract id");
      }
      options.contractIds.push(contractId);
      index += 1;
    } else {
      throw new Error(`unknown database-performance option: ${argument ?? "<missing>"}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  if (options.list) {
    process.stdout.write(
      `${JSON.stringify(
        performanceRegistry.list().map((contract) => ({
          criterionCategories: [contract.workClass],
          description: contract.description,
          id: contract.id,
          workClass: contract.workClass,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  const replay = resolveHostedReplay({
    hosted: options.hosted,
    operatorApproved: options.operatorApproved,
  });
  const scratchDirectory =
    replay.mode === "local" && options.fullFixture
      ? await mkdtemp(join(process.cwd(), ".db-performance-"))
      : null;
  const localUrl =
    scratchDirectory === null ? ":memory:" : `file:${join(scratchDirectory, "fixture.db")}`;
  const client =
    replay.mode === "hosted"
      ? (await import("@libsql/client/web")).createClient({
          authToken: replay.token,
          concurrency: REMOTE_DB_CONCURRENCY,
          url: replay.url,
        })
      : createLocalClient({ concurrency: LOCAL_DB_CONCURRENCY, url: localUrl });
  const runStartedAtMs = performance.now();
  const initialResource = readPerformanceResourceSample();

  try {
    await resetFixture(client);
    await applyFixtureSchema(client);
    const exactFixture = replay.mode === "hosted" || options.fullFixture;
    const counts = exactFixture
      ? getScaleManifest(options.profile).counts
      : createCiFixtureCounts(options.profile);
    const fixtureWriteStartedAtMs = performance.now();
    const written = await writeFixture(client, options.profile, { counts });
    const fixtureWriteCompletedAtMs = performance.now();
    const fixtureWriteDurationMs = Math.max(0, fixtureWriteCompletedAtMs - fixtureWriteStartedAtMs);
    const fixtureResource = readPerformanceResourceSample();
    const fixtureAdjustedSample =
      replay.mode === "local" && options.fullFixture
        ? () =>
            fixtureBaselineAdjustedResourceSample(
              readPerformanceResourceSample(),
              initialResource,
              fixtureResource,
            )
        : undefined;
    const report = await runPerformanceContracts({
      client,
      contracts: selectPerformanceContracts(options.contractIds),
      fixtureCounts: counts,
      profile: options.profile,
      resource: {
        initial:
          fixtureAdjustedSample === undefined
            ? maxPerformanceResourceSample(initialResource, fixtureResource)
            : initialResource,
        sample: fixtureAdjustedSample,
        sampleSource:
          fixtureAdjustedSample === undefined
            ? undefined
            : "process.memoryUsage.fixture-baseline-adjusted",
        startedAtMs:
          fixtureAdjustedSample === undefined ? runStartedAtMs : fixtureWriteCompletedAtMs,
      },
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          clientBounds: DATABASE_CLIENT_BOUNDS,
          environment: replay.mode,
          fixture: {
            counts,
            exactProfileCardinality: exactFixture,
            profile: options.profile,
            writeDurationMs: fixtureWriteDurationMs,
            written,
          },
          indexAudit: report.indexAudit,
          report,
          schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
        },
        null,
        2,
      )}\n`,
    );

    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    client.close();
    if (scratchDirectory !== null) {
      await rm(scratchDirectory, { force: true, recursive: true });
    }
  }
}

await main();
