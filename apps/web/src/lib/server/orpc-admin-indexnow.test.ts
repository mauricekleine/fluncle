import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const catalogue = vi.hoisted(() => ({
  ackIndexNowCatalogue: vi.fn(),
  claimIndexNowCatalogue: vi.fn(),
  walkIndexNowCatalogue: vi.fn(),
}));
vi.mock("./indexnow-catalogue", () => catalogue);
beforeAll(setAdminTokenEnv);
warmOrpcRouter();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network call")));
});

const PATH = "/admin/indexnow/submit";

describe("submit_indexnow transport and agent authority", () => {
  it("lets the agent walk the cursor-bound catalogue window", async () => {
    catalogue.walkIndexNowCatalogue.mockResolvedValue({
      changed: 2,
      checked: 250,
      inserted: 3,
      kind: "artist",
      next: { after: "artist-a", kind: "artist" },
      removed: 4,
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, {
        cursor: { after: "artist-0", kind: "artist" },
        phase: "walk",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      checked: 250,
      next: { after: "artist-a", kind: "artist" },
      ok: true,
      phase: "walk",
      removed: 4,
    });
    expect(catalogue.walkIndexNowCatalogue).toHaveBeenCalledWith({
      after: "artist-0",
      kind: "artist",
    });
  });

  it("returns a read-only limited claim with exact versions and vendor configuration", async () => {
    catalogue.claimIndexNowCatalogue.mockResolvedValue({
      due: 12,
      indexNow: {
        host: "www.fluncle.com",
        key: "public-key",
        keyLocation: "https://www.fluncle.com/key.txt",
      },
      items: [
        {
          changedAt: "2026-10-05",
          fingerprint: "hash",
          kind: "log",
          subjectId: "a",
          url: "https://www.fluncle.com/log/a",
        },
      ],
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { limit: 5, phase: "claim" }));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      due: 12,
      items: [{ changedAt: "2026-10-05", subjectId: "a" }],
      ok: true,
      phase: "claim",
    });
    expect(catalogue.claimIndexNowCatalogue).toHaveBeenCalledWith(5);
    expect(catalogue.ackIndexNowCatalogue).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { phase: "claim" }));
    expect(catalogue.claimIndexNowCatalogue).toHaveBeenLastCalledWith(10000);
  });

  it("acknowledges exact versions with the server clock", async () => {
    catalogue.ackIndexNowCatalogue.mockResolvedValue({ due: 11, stamped: 1 });
    const versions = [
      { changedAt: "2026-10-05T00:00:00.000Z", fingerprint: "hash", kind: "track", subjectId: "a" },
    ];
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { phase: "ack", versions }));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ due: 11, ok: true, phase: "ack", stamped: 1 });
    expect(catalogue.ackIndexNowCatalogue).toHaveBeenCalledWith(versions);
  });

  it.each(["walk", "claim", "ack"])(
    "refuses anonymous %s calls before catalogue work starts",
    async (phase) => {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        req(PATH, "POST", undefined, {
          phase,
          ...(phase === "ack"
            ? {
                versions: [
                  { changedAt: "2026-10-05", fingerprint: "hash", kind: "log", subjectId: "a" },
                ],
              }
            : {}),
        }),
      );
      expect(response?.status).toBe(401);
      expect(catalogue.walkIndexNowCatalogue).not.toHaveBeenCalled();
      expect(catalogue.claimIndexNowCatalogue).not.toHaveBeenCalled();
      expect(catalogue.ackIndexNowCatalogue).not.toHaveBeenCalled();
    },
  );

  it("rejects legacy submission and invalid claims or acknowledgements before database work", async () => {
    const { handleOrpc } = await import("./orpc");
    const version = { changedAt: "2026-10-05", fingerprint: "hash", kind: "log", subjectId: "a" };
    const invalid = [
      { phase: "submit" },
      ...[0, 10001, 1.5].map((limit) => ({ limit, phase: "claim" })),
      { phase: "ack", versions: [] },
      ...[
        { kind: "galaxy" },
        { subjectId: "" },
        { subjectId: "a".repeat(513) },
        { fingerprint: "" },
        { fingerprint: "x".repeat(129) },
        { changedAt: "yesterday" },
      ].map((patch) => ({ phase: "ack", versions: [{ ...version, ...patch }] })),
      { phase: "ack", versions: Array.from({ length: 10001 }, () => version) },
    ];
    for (const input of invalid) {
      const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, input));
      expect(response?.status).toBe(400);
    }
    expect(catalogue.claimIndexNowCatalogue).not.toHaveBeenCalled();
    expect(catalogue.ackIndexNowCatalogue).not.toHaveBeenCalled();
  });

  it("refuses invalid kinds and empty keys at the contract boundary", async () => {
    const { handleOrpc } = await import("./orpc");
    for (const cursor of [{ kind: "galaxy" }, { after: "", kind: "track" }]) {
      const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { cursor, phase: "walk" }));
      expect(response?.status).toBe(400);
    }
    expect(catalogue.walkIndexNowCatalogue).not.toHaveBeenCalled();
  });
});
