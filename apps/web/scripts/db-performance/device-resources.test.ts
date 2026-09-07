import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createCiFixtureCounts } from "./manifest";
import { type DeviceResourceReport } from "./device-resources";

function runBun(args: readonly string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [...args], {
      cwd: new URL("../..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Uint8Array) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (timedOut) {
        reject(new Error("device resource Bun child exceeded its bounded test deadline"));
        return;
      }
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`device resource Bun child failed (${code ?? "signal"}): ${stderr}`));
      }
    });
  });
}

describe("device resource proof", () => {
  it("runs the real local device path over an inexact ratio-preserving source", async () => {
    const report = JSON.parse(
      await runBun([
        "run",
        "scripts/db-performance/device-resources.ts",
        "--ci",
        "--profile",
        "1x",
      ]),
    ) as DeviceResourceReport;
    const counts = createCiFixtureCounts("1x");

    expect(report.schemaVersion).toBe(1);
    expect(report.exactProfileCardinality).toBe(false);
    expect(report.environment).toEqual({
      sourceReplica: "local-file-copy",
      sourceReplicaNetworkMeasured: false,
      target: "local-bun-sqlite",
      targetHostedLibsqlMeasured: false,
    });
    expect(report.fixture.embeddingBytes).toEqual({ maximum: 4096, minimum: 4096 });
    expect(report.fixture.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.fixture.census).toMatchObject({
      findings: counts.findings,
      track_artists: counts.trackArtists,
      track_embeddings: counts.trackEmbeddings,
      tracks: counts.tracks,
    });
    expect(report.windows.samples).toBe(4);
    expect(report.deadline.serviceDeadlineMs).toBe(3_430_000);
    for (const measurement of Object.values(report.measurements)) {
      expect(measurement).toMatchObject({ sampleCount: 1 });
      expect(measurement.wallDurationMs).toBeGreaterThanOrEqual(0);
      expect(measurement.startedAt).toEqual(expect.any(String));
      expect(measurement.completedAt).toEqual(expect.any(String));
    }
    expect(report.peak.heapUsedSampledBytes).toBeGreaterThan(0);
    expect(report.peak.rssHighWaterBytes).toBeGreaterThan(0);
    expect(report.peak.rssSampledBytes).toBeGreaterThan(0);
    expect(report.peak.replicaBytesAfterCheckpoint).toBeGreaterThan(0);
    expect(report.peak.replicaWalBytesBeforeCheckpoint).toBeGreaterThan(0);
    expect(report.peak.replicaWalBytesAfterCheckpoint).toBe(0);
    expect(report.peak.simultaneousGenerationFiles).toBe(2);
    expect(report.peak.simultaneousGenerationLabels).toEqual([
      "candidate-generation",
      "last-verified-generation",
    ]);
    expect(report.peak.aggregateDiskPeakBytes).toBeGreaterThanOrEqual(
      report.peak.simultaneousGenerationBytes,
    );
    for (const parity of Object.values(report.parity)) {
      expect(parity.targetSourceWatermark).toBe(parity.generationFingerprint);
      expect(parity.rowCounts.tracks).toBeGreaterThan(0);
    }
    expect(report.parity.afterFullRebuild.targetSourceWatermark).toBe(
      report.parity.afterFullRebuild.generationFingerprint,
    );
  }, 125_000);

  it("captures each phase before later phases can inflate its duration", async () => {
    const stdout = await runBun(
      [
        "--eval",
        `import { measureDeviceResourceWindow } from "./scripts/db-performance/device-resources";
       let clock = 100;
       const first = await measureDeviceResourceWindow(async () => { clock += 7; return "first"; }, () => clock, () => "2026-01-01T00:00:00.000Z");
       clock += 10000;
       const second = await measureDeviceResourceWindow(async () => { clock += 3; return "second"; }, () => clock, () => "2026-01-01T00:00:01.000Z");
       console.log(JSON.stringify({ first, second }));`,
      ],
      15_000,
    );
    const result = JSON.parse(stdout) as Record<string, unknown>;

    expect(result).toMatchObject({
      first: { result: "first", window: { sampleCount: 1, wallDurationMs: 7 } },
      second: { result: "second", window: { sampleCount: 1, wallDurationMs: 3 } },
    });
  }, 20_000);
});
