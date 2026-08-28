import { type Client, createClient as createLocalClient } from "@libsql/client";

import { LOCAL_DB_CONCURRENCY, REMOTE_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { performanceRegistry, selectPerformanceContracts } from "./contracts";
import {
  HOSTED_FIXTURE_CENSUS_ROW_LIMIT,
  applyFixtureSchema,
  auditFixtureCardinality,
  resetFixture,
  writeFixture,
} from "./fixture";
import { resolveHostedReplay } from "./hosted";
import { type PerformanceFixtureIdentity, verifyFixtureIdentity } from "./materialize";
import {
  type ScaleProfile,
  createCiFixtureCounts,
  getScaleManifest,
  isScaleProfile,
} from "./manifest";
import {
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  executePerformancePhase,
  formatPerformanceExecutionProgress,
  maxPerformanceResourceSample,
  type PerformanceExecutionProgress,
  type PerformanceResourceSample,
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
// Hosted preseed verification performs identity plus one remote request for every census statement
// before contract timing begins. Its whole-process cap therefore adds one scale-matched bootstrap
// window to the unchanged exact-run cap; contract timing remains separately measured post-bootstrap.
const HOSTED_BOOTSTRAP_ALLOWANCE_MS: Record<ScaleProfile, number> = {
  "1x": 5 * 60_000,
  "2x": 8 * 60_000,
  "4x": 12 * 60_000,
};

export type CliOptions = {
  contractIds: string[];
  fullFixture: boolean;
  hosted: boolean;
  list: boolean;
  operatorApproved: boolean;
  preseededFixture: boolean;
  profile: ScaleProfile;
};

export function performanceProcessDeadlineMs(
  options: Pick<CliOptions, "fullFixture" | "hosted" | "profile">,
): number {
  if (options.hosted) {
    return (
      PROFILE_PROCESS_DEADLINE_MS[options.profile] + HOSTED_BOOTSTRAP_ALLOWANCE_MS[options.profile]
    );
  }
  if (options.fullFixture) {
    return PROFILE_PROCESS_DEADLINE_MS[options.profile];
  }
  return CI_PROCESS_DEADLINE_MS;
}

export function parseArguments(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    contractIds: [],
    fullFixture: false,
    hosted: false,
    list: false,
    operatorApproved: false,
    preseededFixture: false,
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
    } else if (argument === "--preseeded-fixture") {
      options.preseededFixture = true;
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

  if (options.hosted && !options.preseededFixture) {
    throw new Error("--hosted requires --preseeded-fixture");
  }
  if (options.preseededFixture && !options.hosted) {
    throw new Error("--preseeded-fixture requires --hosted");
  }
  if (options.hosted && options.fullFixture) {
    throw new Error("--hosted --preseeded-fixture cannot combine with --full-fixture");
  }
  if (options.operatorApproved && !options.hosted) {
    throw new Error("--operator-approved requires --hosted");
  }
  if (
    options.list &&
    (options.hosted || options.operatorApproved || options.preseededFixture || options.fullFixture)
  ) {
    throw new Error("--list cannot combine with fixture or hosted execution flags");
  }

  return options;
}

export type FixtureBootstrap = {
  census: Awaited<ReturnType<typeof auditFixtureCardinality>>;
  identity: PerformanceFixtureIdentity | null;
  mode: "generated" | "preseeded-verified";
  writeDurationMs: number | null;
  written: Awaited<ReturnType<typeof writeFixture>> | null;
};

type RunDependencies = {
  resolveReplay?: typeof resolveHostedReplay;
};

export function writeHostedPerformanceProgress(progress: PerformanceExecutionProgress): void {
  process.stderr.write(`${formatPerformanceExecutionProgress(progress)}\n`);
}

export function performanceWallDurationWarning(environment: "hosted" | "local"): boolean {
  return environment === "hosted";
}

export function contractPhaseResourceBoundary(options: {
  databaseProcessIsolated: boolean;
  fixtureResource: PerformanceResourceSample;
  fixtureWriteCompletedAtMs: number;
  initialResource: PerformanceResourceSample;
  runStartedAtMs: number;
}): { initial: PerformanceResourceSample; startedAtMs: number } {
  return options.databaseProcessIsolated
    ? {
        initial: options.fixtureResource,
        startedAtMs: options.fixtureWriteCompletedAtMs,
      }
    : {
        initial: maxPerformanceResourceSample(options.initialResource, options.fixtureResource),
        startedAtMs: options.runStartedAtMs,
      };
}

export async function prepareFixture(
  client: Client,
  options: {
    hosted: boolean;
    profile: ScaleProfile;
    counts: ReturnType<typeof getScaleManifest>["counts"];
    onProgress?: (progress: PerformanceExecutionProgress) => void;
  },
): Promise<FixtureBootstrap> {
  if (options.hosted) {
    const identity = await executePerformancePhase(
      { phase: "fixture-identity" },
      options.onProgress,
      () => verifyFixtureIdentity(client, options.profile, options.counts),
    );
    const census = await executePerformancePhase({ phase: "fixture-census" }, undefined, () =>
      auditFixtureCardinality(client, options.counts, {
        maxRowsPerStatement: HOSTED_FIXTURE_CENSUS_ROW_LIMIT,
        onRequest: (iteration, iterations) =>
          options.onProgress?.({ iteration, iterations, phase: "fixture-census" }),
        statementsPerRequest: 1,
      }),
    );
    if (!census.passed) {
      throw new Error(`preseeded fixture census failed: ${census.mismatches.join("; ")}`);
    }

    return {
      census,
      identity,
      mode: "preseeded-verified",
      writeDurationMs: null,
      written: null,
    };
  }

  await resetFixture(client);
  await applyFixtureSchema(client);
  const fixtureWriteStartedAtMs = performance.now();
  const written = await writeFixture(client, options.profile, { counts: options.counts });
  const census = await auditFixtureCardinality(client, options.counts);

  return {
    census,
    identity: null,
    mode: "generated",
    writeDurationMs: Math.max(0, performance.now() - fixtureWriteStartedAtMs),
    written,
  };
}

export async function main(options: CliOptions, dependencies: RunDependencies = {}): Promise<void> {
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

  const contracts = selectPerformanceContracts(options.contractIds);
  const replay = (dependencies.resolveReplay ?? resolveHostedReplay)({
    fullFixture: options.fullFixture,
    hosted: options.hosted,
    operatorApproved: options.operatorApproved,
    preseededFixture: options.preseededFixture,
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
    const onProgress = replay.mode === "hosted" ? writeHostedPerformanceProgress : undefined;
    const exactFixture = replay.mode === "hosted" || options.fullFixture;
    const counts = exactFixture
      ? getScaleManifest(options.profile).counts
      : createCiFixtureCounts(options.profile);
    const bootstrap = await prepareFixture(client, {
      counts,
      hosted: replay.mode === "hosted",
      onProgress,
      profile: options.profile,
    });
    const fixtureWriteCompletedAtMs = performance.now();
    const fixtureResource = readPerformanceResourceSample();
    const isolatedExactLocalRun = localSidecar !== null;
    const contractResourceBoundary = contractPhaseResourceBoundary({
      databaseProcessIsolated: replay.mode === "hosted" || isolatedExactLocalRun,
      fixtureResource,
      fixtureWriteCompletedAtMs,
      initialResource,
      runStartedAtMs,
    });
    const report = await runPerformanceContracts({
      client,
      contracts,
      fixtureCounts: counts,
      onProgress,
      profile: options.profile,
      resource: {
        initial: contractResourceBoundary.initial,
        sampleSource: localSidecar?.resourceSampleSource,
        startedAtMs: contractResourceBoundary.startedAtMs,
        wallDurationWarning: performanceWallDurationWarning(replay.mode),
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
            bootstrap: bootstrap.mode,
            census: bootstrap.census,
            counts,
            exactProfileCardinality: exactFixture && bootstrap.census.passed,
            identity: bootstrap.identity,
            profile: options.profile,
            writeDurationMs: bootstrap.writeDurationMs,
            written: bootstrap.written,
          },
          indexAudit: report.indexAudit,
          report,
          schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
        },
        null,
        2,
      )}\n`,
    );

    if (!report.passed || !bootstrap.census.passed) {
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

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const processDeadlineMs = performanceProcessDeadlineMs(options);
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
}
