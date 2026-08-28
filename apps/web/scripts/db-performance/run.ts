import { createClient as createLocalClient } from "@libsql/client";

import { LOCAL_DB_CONCURRENCY, REMOTE_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { performanceRegistry, selectPerformanceContracts } from "./contracts";
import { applyFixtureSchema, auditFixtureCardinality, resetFixture, writeFixture } from "./fixture";
import { resolveHostedReplay } from "./hosted";
import {
  type ScaleProfile,
  createCiFixtureCounts,
  getScaleManifest,
  isScaleProfile,
} from "./manifest";
import {
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  maxPerformanceResourceSample,
  readPerformanceResourceSample,
  runPerformanceContracts,
} from "./registry";
import { performanceFetchWithTimeout, startLocalLibsqlSidecar } from "./local-sidecar";

const REMOTE_REQUEST_TIMEOUT_MS = 60_000;
const CI_PROCESS_DEADLINE_MS = 2 * 60_000;
const PROFILE_PROCESS_DEADLINE_MS: Record<ScaleProfile, number> = {
  "1x": 5 * 60_000,
  "2x": 8 * 60_000,
  "4x": 12 * 60_000,
};

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

async function main(options: CliOptions): Promise<void> {
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
  const localSidecar =
    replay.mode === "local" && options.fullFixture
      ? await startLocalLibsqlSidecar({
          cwd: process.cwd(),
          scratchRoot: process.env.FLUNCLE_DB_PERFORMANCE_SCRATCH_ROOT,
        })
      : null;
  const client =
    replay.mode === "hosted"
      ? (await import("@libsql/client/web")).createClient({
          authToken: replay.token,
          concurrency: REMOTE_DB_CONCURRENCY,
          fetch: performanceFetchWithTimeout(REMOTE_REQUEST_TIMEOUT_MS),
          url: replay.url,
        })
      : (localSidecar?.client ??
        createLocalClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" }));
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
    const census = await auditFixtureCardinality(client, counts);
    const fixtureWriteCompletedAtMs = performance.now();
    const fixtureWriteDurationMs = Math.max(0, fixtureWriteCompletedAtMs - fixtureWriteStartedAtMs);
    const fixtureResource = readPerformanceResourceSample();
    const isolatedExactLocalRun = localSidecar !== null;
    const report = await runPerformanceContracts({
      client,
      contracts: selectPerformanceContracts(options.contractIds),
      fixtureCounts: counts,
      profile: options.profile,
      resource: {
        initial: isolatedExactLocalRun
          ? fixtureResource
          : maxPerformanceResourceSample(initialResource, fixtureResource),
        sampleSource: localSidecar?.resourceSampleSource,
        startedAtMs: isolatedExactLocalRun ? fixtureWriteCompletedAtMs : runStartedAtMs,
      },
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          clientBounds: DATABASE_CLIENT_BOUNDS,
          database: {
            isolation:
              replay.mode === "hosted"
                ? "hosted-remote"
                : isolatedExactLocalRun
                  ? "local-sidecar-process"
                  : "embedded-client-process",
            resourceScope:
              replay.mode === "hosted" || isolatedExactLocalRun
                ? "benchmark-client-process"
                : "benchmark-client-and-database-process",
            transport:
              replay.mode === "hosted"
                ? "remote-libsql"
                : isolatedExactLocalRun
                  ? "local-http"
                  : "embedded",
          },
          environment: replay.mode,
          fixture: {
            census,
            counts,
            exactProfileCardinality: exactFixture && census.passed,
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

    if (!report.passed || !census.passed) {
      process.exitCode = 1;
    }
  } finally {
    if (localSidecar === null) {
      client.close();
    } else {
      await localSidecar.close();
    }
  }
}

const options = parseArguments(process.argv.slice(2));
const processDeadlineMs =
  options.fullFixture || options.hosted
    ? PROFILE_PROCESS_DEADLINE_MS[options.profile]
    : CI_PROCESS_DEADLINE_MS;
const processDeadline = setTimeout(() => {
  process.stderr.write(
    `database-performance profile exceeded its ${processDeadlineMs}ms absolute deadline\n`,
  );
  process.exit(124);
}, processDeadlineMs);
try {
  await main(options);
} finally {
  clearTimeout(processDeadline);
}
