import { describe, expect, it } from "vitest";

import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { simulateMixedLoad, simulateRequestWideMixedLoad } from "./mixed-load";

describe("deterministic per-client mixed load", () => {
  it("keeps public reads moving beside a held reader and serializes write batches", () => {
    const report = simulateMixedLoad();
    const held = report.events.find((event) => event.id === "heavy-reader-held");
    const reads = report.events.filter((event) => event.workClass === "public-read");
    const writes = report.events.filter((event) => event.workClass === "write-batch");

    expect(report.scope).toBe("per-client-simulator");
    expect(report.bounds).toEqual(DATABASE_CLIENT_BOUNDS);
    expect(report.violations).toEqual([]);
    expect(held?.completedAtMs).toBe(100);
    expect(reads.every((read) => read.startedAtMs < (held?.completedAtMs ?? 0))).toBe(true);
    expect(report.queueMs["public-read"]).toEqual({ max: 0, p50: 0, p95: 0, p99: 0 });
    expect(report.latencyMs["public-read"]).toEqual({ max: 5, p50: 5, p95: 5, p99: 5 });
    expect(writes[1]?.startedAtMs).toBeGreaterThanOrEqual(writes[0]?.completedAtMs ?? 0);
    expect(report.maxConcurrentByClient.primary).toBeLessThanOrEqual(4);
  });

  it("rejects the avoidable one-slot convoy", () => {
    const report = simulateMixedLoad({
      bounds: { ...DATABASE_CLIENT_BOUNDS, primary: 1 },
    });

    expect(report.violations).toContain("primary bound 1 differs from the contract 4");
    expect(report.violations).toContain("public reads convoyed behind the held heavy reader");
    expect(report.queueMs["public-read"].p95).toBeGreaterThan(0);
  });

  it("rejects the library's hidden default concurrency", () => {
    const report = simulateMixedLoad({
      bounds: { ...DATABASE_CLIENT_BOUNDS, primary: 20 },
    });

    expect(report.violations).toContain("primary bound 20 differs from the contract 4");
  });
});

describe("deterministic request-wide mixed load", () => {
  it("bounds several request-local fan-outs and keeps public seats beside a held heavy reader", () => {
    const report = simulateRequestWideMixedLoad();

    expect(report.scope).toBe("worker-isolate-simulator");
    expect(report.violations).toEqual([]);
    expect(report.aggregateCeiling).toBe(4);
    expect(report.aggregateObservedMaximum).toBe(4);
    expect(report.publicRequestCount).toBe(3);
    expect(report.fanoutPerPublicRequest).toBe(4);
    expect(report.publicReadsAdmittedBesideHeldReader).toBeGreaterThanOrEqual(3);
    expect(report.latencyMs["heavy-reader"]).toMatchObject({ p50: 100, p95: 100, p99: 100 });
    expect(report.latencyMs["public-read"]).toMatchObject({
      p50: expect.any(Number),
      p95: expect.any(Number),
      p99: expect.any(Number),
    });
    expect(report.latencyMs["write-batch"]).toMatchObject({
      p50: expect.any(Number),
      p95: expect.any(Number),
      p99: expect.any(Number),
    });
    expect(
      Object.values(report.maxConcurrentByClientInstance).every((maximum) => maximum <= 4),
    ).toBe(true);
  });

  it("exposes the multiplication that the aggregate ceiling prevents", () => {
    const report = simulateRequestWideMixedLoad({ aggregateCeiling: 20 });

    expect(report.violations).toContain("Worker aggregate ceiling 20 differs from the contract 4");
    expect(report.aggregateObservedMaximum).toBeGreaterThan(4);
  });
});
