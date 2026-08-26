import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

let gets: string[] = [];
let posts: Array<{ body: unknown; path: string }> = [];
const response = { ok: true };

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    gets.push(path);
    return response;
  },
  adminApiPost: async (path: string, body?: unknown) => {
    posts.push({ body, path });
    return response;
  },
}));

const {
  acknowledgeArtifactChangesCommand,
  activateArtifactConsumerCommand,
  checkpointArtifactRebuildCommand,
  compactArtifactChangesCommand,
  getArtifactConsumerCommand,
  inactivateArtifactConsumerCommand,
  listArtifactChangesCommand,
  listArtifactSnapshotCommand,
  parseArtifactContracts,
  parseArtifactInteger,
  parseArtifactStream,
  registerArtifactConsumerCommand,
} = await import("./admin-artifacts");

beforeEach(() => {
  gets = [];
  posts = [];
});

describe("artifact consumer HTTP transport", () => {
  test("serializes registration, status, and lifecycle transitions", async () => {
    const contract = { formatVersion: 1, stream: "sonar.track" as const, streamVersion: 1 };

    expect(
      (
        await registerArtifactConsumerCommand({
          consumerId: "goal-g:box",
          contracts: [contract],
        })
      ).ok,
    ).toBe(true);
    expect((await getArtifactConsumerCommand("goal-g:box")).ok).toBe(true);
    expect((await activateArtifactConsumerCommand("goal-g:box")).ok).toBe(true);
    expect((await inactivateArtifactConsumerCommand("goal-g:box")).ok).toBe(true);

    expect(gets).toEqual(["/api/v1/admin/artifacts/consumers/goal-g%3Abox"]);
    expect(posts).toEqual([
      {
        body: { consumerId: "goal-g:box", contracts: [contract] },
        path: "/api/v1/admin/artifacts/consumers",
      },
      {
        body: { consumerId: "goal-g:box" },
        path: "/api/v1/admin/artifacts/consumers/goal-g%3Abox/activate",
      },
      {
        body: { consumerId: "goal-g:box" },
        path: "/api/v1/admin/artifacts/consumers/goal-g%3Abox/inactivate",
      },
    ]);
  });

  test("serializes bounded snapshot pages and their exact digest checkpoint", async () => {
    await listArtifactSnapshotCommand({
      consumerId: "goal-g",
      limit: 200,
      stream: "device.track-artist",
      streamVersion: 1,
    });
    await checkpointArtifactRebuildCommand({
      consumerDigest: "a".repeat(64),
      consumerId: "goal-g",
      consumerItemCount: 9,
      generation: "1:device.track-artist:1:1:0",
      pageDigest: "b".repeat(64),
      pageLimit: 200,
      stream: "device.track-artist",
      streamVersion: 1,
    });

    expect(gets).toEqual([
      "/api/v1/admin/artifacts/snapshots?consumerId=goal-g&limit=200&stream=device.track-artist&streamVersion=1",
    ]);
    expect(posts).toEqual([
      {
        body: {
          consumerDigest: "a".repeat(64),
          consumerId: "goal-g",
          consumerItemCount: 9,
          generation: "1:device.track-artist:1:1:0",
          pageDigest: "b".repeat(64),
          pageLimit: 200,
          stream: "device.track-artist",
          streamVersion: 1,
        },
        path: "/api/v1/admin/artifacts/consumers/goal-g/rebuilds/device.track-artist/checkpoint",
      },
    ]);
  });

  test("serializes ordered change reads, exact acknowledgement, and bounded compaction", async () => {
    await listArtifactChangesCommand({ consumerId: "goal-g", limit: 500 });
    await acknowledgeArtifactChangesCommand({
      batchDigest: "c".repeat(64),
      consumerId: "goal-g",
      eventCount: 4,
      fromSeq: 11,
      throughSeq: 14,
    });
    await compactArtifactChangesCommand(1_000);

    expect(gets).toEqual(["/api/v1/admin/artifacts/changes?consumerId=goal-g&limit=500"]);
    expect(posts).toEqual([
      {
        body: {
          batchDigest: "c".repeat(64),
          consumerId: "goal-g",
          eventCount: 4,
          fromSeq: 11,
          throughSeq: 14,
        },
        path: "/api/v1/admin/artifacts/consumers/goal-g/checkpoint",
      },
      {
        body: { limit: 1_000 },
        path: "/api/v1/admin/artifacts/changes/compact",
      },
    ]);
  });
});

describe("artifact CLI boundary", () => {
  test("accepts only exact registered contracts and unique declarations", () => {
    expect(parseArtifactContracts(["sonar.track@1/1", "device.track@1/1"])).toEqual([
      { formatVersion: 1, stream: "sonar.track", streamVersion: 1 },
      { formatVersion: 1, stream: "device.track", streamVersion: 1 },
    ]);
    expect(() => parseArtifactContracts(["sonar.track@2/1"])).toThrow(
      "Unsupported artifact contract",
    );
    expect(() => parseArtifactContracts(["sonar.track@1/1", "sonar.track@1/1"])).toThrow(
      "must be unique",
    );
    expect(() => parseArtifactContracts([])).toThrow("At least one --contract");
    expect(parseArtifactStream("device.track-artist")).toBe("device.track-artist");
    expect(() => parseArtifactStream("future.track")).toThrow("Unsupported artifact stream");
  });

  test("rejects unsafe, fractional, negative, and over-cap integers", () => {
    expect(parseArtifactInteger("0", "--seq", { minimum: 0 })).toBe(0);
    expect(parseArtifactInteger("500", "--limit", { maximum: 500 })).toBe(500);
    expect(() => parseArtifactInteger("501", "--limit", { maximum: 500 })).toThrow(
      "between 1 and 500",
    );
    expect(() => parseArtifactInteger("1.5", "--limit")).toThrow("safe integer");
    expect(() => parseArtifactInteger("9007199254740992", "--seq", { minimum: 0 })).toThrow(
      "safe integer",
    );
  });
});
