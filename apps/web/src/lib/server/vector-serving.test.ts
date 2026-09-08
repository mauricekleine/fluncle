import { beforeEach, describe, expect, it, vi } from "vitest";

import { type ArtifactConsumerStatus } from "@fluncle/contracts/orpc";

const getArtifactConsumerStatusLive = vi.hoisted(() => vi.fn());
const readSonarHealth = vi.hoisted(() => vi.fn());
const setSonarTrackEnabled = vi.hoisted(() => vi.fn());
let enabled = false;

vi.mock("./artifact-changes", () => ({ getArtifactConsumerStatusLive }));
vi.mock("./sonar", () => ({
  SONAR_DELTA_CADENCE_SECS: 30,
  SONAR_RECONCILE_CADENCE_SECS: 3600,
  isSonarTrackEnabled: async () => enabled,
  readSonarHealth,
  setSonarTrackEnabled,
}));

import { assessVectorServing, getVectorServingStatus, setVectorServing } from "./vector-serving";

const NOW = Date.parse("2026-09-08T18:00:00.000Z");
const health = {
  artifactVersion: "sonar.track@1/1",
  checkpoint: 42,
  commit: "a".repeat(40),
  consumerId: "sonar-test",
  deltaAgeSeconds: 0,
  deltaBacklog: 0,
  headSeq: 42,
  ok: true,
  pendingAck: false,
  replicaLagSeconds: 30,
  tracks: 12,
  validation: "valid" as const,
};
const consumer: ArtifactConsumerStatus = {
  appliedThroughSeq: 42,
  checkpointedAt: "2026-09-08T17:59:45.000Z",
  compactionBarrier: 42,
  consumerId: "sonar-test",
  contracts: [{ formatVersion: 1, stream: "sonar.track", streamVersion: 1 }],
  earliestSeq: 1,
  headSeq: 42,
  rebuilds: [
    {
      completedAt: "2026-09-08T17:00:00.000Z",
      consumerDigest: "a".repeat(64),
      consumerItemCount: 12,
      cursor: null,
      formatVersion: 1,
      generation: "test",
      snapshotSeq: 42,
      sourceDigest: "a".repeat(64),
      sourceItemCount: 12,
      startedAt: "2026-09-08T16:59:00.000Z",
      state: "complete",
      stream: "sonar.track",
      streamVersion: 1,
      updatedAt: "2026-09-08T17:00:00.000Z",
    },
  ],
  registeredAt: "2026-09-08T16:59:00.000Z",
  snapshotSeq: 42,
  state: "active",
  stateChangedAt: "2026-09-08T17:00:00.000Z",
  updatedAt: "2026-09-08T17:59:45.000Z",
};

beforeEach(() => {
  enabled = false;
  getArtifactConsumerStatusLive.mockReset().mockResolvedValue(consumer);
  readSonarHealth.mockReset().mockResolvedValue(health);
  setSonarTrackEnabled.mockReset().mockImplementation(async (value: boolean) => {
    enabled = value;
  });
});

describe("track vector-serving readiness", () => {
  it("opens only from an identified, validated, acknowledged index at the current producer head", () => {
    const status = assessVectorServing({ consumer, enabled: false, health, nowMs: NOW });

    expect(status.commissioning).toEqual({ ready: true, reasons: [] });
    expect(status.runtime).toEqual({ ready: true, reasons: [] });
  });

  it("separates first-open currentness from healthy steady-state delta debt", () => {
    const status = assessVectorServing({
      consumer: { ...consumer, headSeq: 44 },
      enabled: true,
      health: { ...health, deltaAgeSeconds: 15, deltaBacklog: 2, headSeq: 44 },
      nowMs: NOW,
    });

    expect(status.commissioning).toEqual({ ready: false, reasons: ["producer_backlog"] });
    expect(status.runtime).toEqual({ ready: true, reasons: [] });
  });

  it("tolerates the normal publish-to-ack race at runtime but never for first commissioning", () => {
    const status = assessVectorServing({
      consumer: { ...consumer, appliedThroughSeq: 41 },
      enabled: true,
      health: { ...health, pendingAck: true },
      nowMs: NOW,
    });

    expect(status.commissioning.reasons).toEqual(["pending_ack", "checkpoint_mismatch"]);
    expect(status.runtime).toEqual({ ready: true, reasons: [] });
  });

  it("detects an old boot from the producer head even when engine-local backlog claims zero", () => {
    const status = assessVectorServing({
      consumer: {
        ...consumer,
        checkpointedAt: "2026-09-08T17:00:00.000Z",
        headSeq: 50,
      },
      enabled: false,
      health,
      nowMs: NOW,
    });

    expect(status.commissioning.reasons).toContain("producer_backlog");
    expect(status.runtime.reasons).toContain("delta_stale");
  });

  it("reports a stuck refresh through the existing validation and age bounds", () => {
    const status = assessVectorServing({
      consumer: {
        ...consumer,
        appliedThroughSeq: 41,
        checkpointedAt: "2026-09-08T17:00:00.000Z",
        headSeq: 50,
      },
      enabled: true,
      health: { ...health, pendingAck: true, validation: "last_attempt_failed" },
      nowMs: NOW,
    });

    expect(status.runtime.reasons).toEqual(["validation_failed", "delta_stale"]);
  });

  it("requires an identified commit build without claiming release provenance", () => {
    const status = assessVectorServing({
      consumer,
      enabled: false,
      health: { ...health, commit: "unknown" },
      nowMs: NOW,
    });

    expect(status.commissioning.reasons).toContain("build_identity_missing");
    expect(status.runtime.reasons).not.toContain("build_identity_missing");
  });

  it("blocks pending validation and uses the hourly replica cadence", () => {
    const status = assessVectorServing({
      consumer,
      enabled: false,
      health: {
        ...health,
        pendingAck: true,
        replicaLagSeconds: 10_801,
        validation: "last_attempt_failed",
      },
      nowMs: NOW,
    });

    expect(status.commissioning.reasons).toEqual([
      "validation_failed",
      "pending_ack",
      "replica_stale",
    ]);
  });

  it("disables unconditionally even while Sonar is unavailable", async () => {
    enabled = true;
    readSonarHealth.mockResolvedValue(null);

    const status = await setVectorServing(false);

    expect(setSonarTrackEnabled).toHaveBeenCalledWith(false);
    expect(status.enabled).toBe(false);
  });

  it("guards the first enable but leaves an already-enabled target idempotent", async () => {
    readSonarHealth.mockResolvedValue(null);
    await expect(setVectorServing(true)).rejects.toMatchObject({
      code: "vector_serving_not_ready",
    });
    expect(setSonarTrackEnabled).not.toHaveBeenCalled();

    enabled = true;
    await expect(setVectorServing(true)).resolves.toMatchObject({ enabled: true });
    expect(setSonarTrackEnabled).not.toHaveBeenCalled();
  });

  it("reads the consumer named by authenticated health and enables after the guard", async () => {
    const before = await getVectorServingStatus();
    expect(before.commissioning.ready).toBe(true);
    expect(getArtifactConsumerStatusLive).toHaveBeenCalledWith("sonar-test");

    const after = await setVectorServing(true);
    expect(setSonarTrackEnabled).toHaveBeenCalledWith(true);
    expect(after.enabled).toBe(true);
  });
});
