import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

const calls: { body?: unknown; method: string; path: string }[] = [];
const status = {
  commissioning: { ready: true, reasons: [] },
  enabled: false,
  evidence: {
    artifactVersion: "sonar.track@1/1",
    checkpoint: 42,
    checkpointedAt: "2026-09-08T17:59:45.000Z",
    commit: "a".repeat(40),
    consumerAppliedThroughSeq: 42,
    consumerHeadSeq: 42,
    consumerId: "sonar-test",
    consumerState: "active",
    deltaAgeSeconds: 0,
    deltaBacklog: 0,
    pendingAck: false,
    replicaLagSeconds: 10,
    tracks: 12,
    validation: "valid",
  },
  runtime: { ready: true, reasons: [] },
  target: "tracks",
} as const;

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    calls.push({ method: "GET", path });
    return { ok: true, status };
  },
  adminApiPut: async (path: string, body: unknown) => {
    calls.push({ body, method: "PUT", path });
    return { ok: true, status: { ...status, enabled: (body as { enabled: boolean }).enabled } };
  },
}));

const vectors = await import("./admin-vectors");

beforeEach(() => {
  calls.length = 0;
});

describe("vector-serving operator commands", () => {
  test("uses the fixed tracks GET and PUT transports", async () => {
    await vectors.getVectorServingCommand("tracks");
    await vectors.setVectorServingCommand({ enabled: true, target: "tracks" });

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/admin/vectors/tracks/serving" },
      {
        body: { enabled: true },
        method: "PUT",
        path: "/api/v1/admin/vectors/tracks/serving",
      },
    ]);
  });

  test("accepts only the tracks target and exact booleans", () => {
    expect(vectors.parseVectorTarget("tracks")).toBe("tracks");
    expect(() => vectors.parseVectorTarget("artists")).toThrow("target must be tracks");
    expect(vectors.parseVectorEnabled("true")).toBe(true);
    expect(vectors.parseVectorEnabled("false")).toBe(false);
    expect(() => vectors.parseVectorEnabled("1")).toThrow("--enabled must be true or false");
  });
});
