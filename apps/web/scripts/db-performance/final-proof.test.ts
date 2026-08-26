import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  checkAdmissionArchitecture,
  checkDeviceArchitecture,
  checkReceiptArchitecture,
  checkSonarArchitecture,
  classifyReceiptStates,
  finalProofArchitectureEvidence,
  finalProofContracts,
  simulateDeviceConvergence,
  simulateFencedAdmission,
  simulateSonarConvergence,
} from "./final-proof";
import { applyFixtureSchema, writeFixture } from "./fixture";
import { createCiFixtureCounts } from "./manifest";
import { selectPerformanceContracts } from "./contracts";
import {
  type PerformanceClient,
  fixtureBaselineAdjustedResourceSample,
  runPerformanceContracts,
} from "./registry";

const NOOP_CLIENT: PerformanceClient = {
  async execute() {
    return { rows: [] };
  },
};

describe("final database proof contracts", () => {
  it("removes embedded fixture RSS while retaining the application baseline", () => {
    expect(
      fixtureBaselineAdjustedResourceSample(
        { heapUsedBytes: 80, rssBytes: 1_250 },
        { heapUsedBytes: 50, rssBytes: 200 },
        { heapUsedBytes: 70, rssBytes: 1_200 },
      ),
    ).toEqual({ heapUsedBytes: 80, rssBytes: 250 });
    expect(
      fixtureBaselineAdjustedResourceSample(
        { heapUsedBytes: 60, rssBytes: 1_100 },
        { heapUsedBytes: 50, rssBytes: 200 },
        { heapUsedBytes: 70, rssBytes: 1_200 },
      ),
    ).toEqual({ heapUsedBytes: 60, rssBytes: 200 });
  });

  it("passes the deterministic admission, receipt, Sonar, and device proofs", async () => {
    const admission = simulateFencedAdmission();
    const receipts = classifyReceiptStates();
    const sonar = simulateSonarConvergence();
    const device = simulateDeviceConvergence();

    expect(admission.violations, JSON.stringify(admission)).toEqual([]);
    expect(admission).toMatchObject({
      convergenceFailures: 0,
      fencingViolations: 0,
      fifoViolations: 0,
      staleFenceRejected: true,
      uncontendedAcquisitionViolations: 0,
    });
    expect(receipts).toMatchObject({ unresolvedOutcomes: 0, violations: [] });
    expect(sonar).toMatchObject({
      convergenceFailures: 0,
      remoteFullCorpusScans: 0,
      violations: [],
    });
    expect(device).toMatchObject({
      atomicityViolations: 0,
      convergenceFailures: 0,
      repeatedProductionCorpusScans: 0,
      violations: [],
    });
  });

  it("fails malformed and unbounded deterministic proof inputs", () => {
    const malformedAdmission = simulateFencedAdmission([
      {
        durationMs: 0,
        enqueuedAtMs: 0,
        heavyRead: false,
        id: "bad",
        lane: "write",
      },
    ]);
    const unboundedAdmission = simulateFencedAdmission(
      Array.from({ length: 101 }, (_value, index) => ({
        durationMs: 1,
        enqueuedAtMs: index,
        heavyRead: false,
        id: `writer-${index}`,
        lane: "write" as const,
      })),
    );
    const malformedReceipt = classifyReceiptStates(["unknown" as never]);
    const malformedSonar = simulateSonarConvergence([
      { kind: "not-a-step", source: "remote-api" } as never,
    ]);
    const unboundedSonar = simulateSonarConvergence(
      Array.from({ length: 101 }, () => ({
        kind: "replica-sync",
        source: "local-replica" as const,
      })),
    );
    const malformedDevice = simulateDeviceConvergence([
      { generation: 1, kind: "not-a-step" } as never,
    ]);
    const unboundedDevice = simulateDeviceConvergence(
      Array.from({ length: 101 }, () => ({ generation: 1, kind: "replica-sync" as const })),
    );

    expect(malformedAdmission.violations.length).toBeGreaterThan(0);
    expect(unboundedAdmission.violations.length).toBeGreaterThan(0);
    expect(malformedReceipt.unresolvedOutcomes).toBe(1);
    expect(malformedReceipt.violations.length).toBeGreaterThan(0);
    expect(malformedSonar.convergenceFailures).toBeGreaterThan(0);
    expect(unboundedSonar.convergenceFailures).toBeGreaterThan(0);
    expect(malformedDevice.convergenceFailures).toBeGreaterThan(0);
    expect(unboundedDevice.convergenceFailures).toBeGreaterThan(0);
  });

  it("fails remote full-corpus and production-corpus scan variants", () => {
    const sonar = simulateSonarConvergence([{ kind: "full-corpus-scan", source: "remote-api" }]);
    const device = simulateDeviceConvergence([
      { generation: 1, kind: "replica-sync" },
      { generation: 1, kind: "production-corpus-scan" },
    ]);

    expect(sonar.remoteFullCorpusScans).toBe(1);
    expect(sonar.convergenceFailures).toBeGreaterThan(0);
    expect(device.repeatedProductionCorpusScans).toBe(1);
    expect(device.convergenceFailures).toBeGreaterThan(0);
  });

  it("carries queue and projection convergence evidence through existing contracts", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: createCiFixtureCounts("1x", 512) });
      const report = await runPerformanceContracts({
        client,
        contracts: selectPerformanceContracts([
          "fixture.due-work-ready",
          "fixture.due-work-ready-empty",
          "projection.crawl-two-lane-read",
        ]),
        fixtureCounts: createCiFixtureCounts("1x", 512),
        profile: "1x",
      });

      expect(report.passed).toBe(true);
      expect(report.contracts.map((contract) => contract.convergence?.category)).toEqual([
        "queue",
        "queue",
        "projection",
      ]);
      expect(report.contracts.every((contract) => contract.convergence?.converged)).toBe(true);
      expect(report.criteria.queue.addressed).toBe(true);
      expect(report.criteria.projection.addressed).toBe(true);
    } finally {
      client.close();
    }
  });

  it("runs every source-shape model check at every local scale", async () => {
    for (const profile of ["1x", "2x", "4x"] as const) {
      const report = await runPerformanceContracts({
        client: NOOP_CLIENT,
        contracts: finalProofContracts(),
        profile,
      });

      expect(report.passed).toBe(true);
      for (const category of [
        "writer-admission",
        "mutation",
        "sonar-refresh",
        "device-derivation",
      ] as const) {
        expect(report.criteria[category]).toMatchObject({ addressed: true, passed: true });
      }
      expect(
        report.contracts.every((contract) =>
          contract.metadata.every(
            (metadata) =>
              metadata.evidenceKind === "source-shape-model-check" &&
              metadata.profileScaleExecution === false,
          ),
        ),
      ).toBe(true);
      expect(report.resources.warningThresholds).toEqual(
        profile === "4x"
          ? {
              heapUsedBytes: expect.any(Number),
              rssBytes: expect.any(Number),
              wallDurationMs: expect.any(Number),
            }
          : expect.any(Object),
      );
    }
  });

  it("fails a 4x bounded-memory limit while keeping timing a warning curve", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "resource warning pin",
          async execute() {
            return { durationMs: 1, resultRowCount: 1 };
          },
          id: "route.resource-warning-pin",
          iterations: 1,
          workClass: "route-db",
        },
      ],
      now: () => 0,
      profile: "4x",
      resource: {
        initial: {
          heapUsedBytes: 300 * 1024 * 1024,
          rssBytes: 600 * 1024 * 1024,
        },
        sample: () => ({
          heapUsedBytes: 300 * 1024 * 1024,
          rssBytes: 600 * 1024 * 1024,
        }),
        startedAtMs: 0,
      },
    });

    expect(report.passed).toBe(false);
    expect(report.resources.peak).toEqual({
      heapUsedBytes: 300 * 1024 * 1024,
      rssBytes: 600 * 1024 * 1024,
      wallDurationMs: 0,
    });
    expect(report.resources.failures).toEqual([
      "heapUsedBytes 314572800 exceeds 268435456",
      "rssBytes 629145600 exceeds 536870912",
    ]);
    expect(report.resources.warnings).toEqual([]);
    expect(report.criteria.resources).toMatchObject({ addressed: true, passed: false });
    expect(report.criteria.resources.warnings).toEqual(report.resources.warnings);
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      resources: { mode: "bounded-memory-timing-warning", sampleSource: "provided" },
      schemaVersion: 3,
    });
  });

  it("keeps a 4x elapsed-time threshold as a machine-readable warning", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [],
      now: () => 180_001,
      profile: "4x",
      resource: {
        initial: { heapUsedBytes: 1, rssBytes: 1 },
        sample: () => ({ heapUsedBytes: 1, rssBytes: 1 }),
        startedAtMs: 0,
      },
    });

    expect(report.passed).toBe(true);
    expect(report.resources.failures).toEqual([]);
    expect(report.resources.warnings).toEqual(["wallDurationMs 180001 exceeds 180000"]);
  });

  it("fails a required resource budget at current and 2x", async () => {
    for (const profile of ["1x", "2x"] as const) {
      const report = await runPerformanceContracts({
        client: NOOP_CLIENT,
        contracts: [],
        now: () => 0,
        profile,
        resource: {
          initial: {
            heapUsedBytes: 1024 * 1024 * 1024,
            rssBytes: 1024 * 1024 * 1024,
          },
          sample: () => ({
            heapUsedBytes: 1024 * 1024 * 1024,
            rssBytes: 1024 * 1024 * 1024,
          }),
          startedAtMs: 0,
        },
      });

      expect(report.passed).toBe(false);
      expect(report.resources).toMatchObject({ mode: "required", warnings: [] });
      expect(report.resources.failures.length).toBeGreaterThan(0);
      expect(report.criteria.resources.passed).toBe(false);
    }
  });

  it("rejects architecture regressions instead of accepting zeroed evidence", () => {
    expect(
      checkAdmissionArchitecture("order by enqueued_at_ms asc, contender_id asc limit 1", "")
        .failures.length,
    ).toBeGreaterThan(0);
    expect(
      checkReceiptArchitecture("const preflight = await lookupReceipt();").failures.length,
    ).toBeGreaterThan(0);
    expect(checkSonarArchitecture("", "self.api.tracks()", "").failures.length).toBeGreaterThan(0);
    expect(checkDeviceArchitecture("rm(args.out)", "").failures.length).toBeGreaterThan(0);
  });

  it("proves the checked-in architecture bundle is available", async () => {
    const evidence = await finalProofArchitectureEvidence();

    expect(evidence.checks).toBeGreaterThan(0);
    expect(evidence.failures).toEqual([]);
  });
});
