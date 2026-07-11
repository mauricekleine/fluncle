import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, setAdminTokenEnv } from "./orpc-test-kit";

// The mixability ops driven end-to-end through `handleOrpc` (RFC mixability-engine):
//   - list_mixable_tracks (GET /tracks/{idOrLogId}/mixable) — public-unauth, the /mix
//     rail. Passes the exclude/limit through, strips private fields, keeps the reason.
//   - get_mixable_order (GET /admin/tracks/mixable-order) — admin tier (agent-allowed),
//     the dream-weaver. Proves the STATIC route wins over /admin/tracks/{trackId}, the
//     2..64 + Log-ID validation 400s, and the auth tier. Only the DB read is mocked.

const getMixableTracks = vi.fn();
const getMixableOrder = vi.fn();

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    getMixableOrder: (...args: unknown[]) => getMixableOrder(...args),
    getMixableTracks: (...args: unknown[]) => getMixableTracks(...args),
  };
});

// A `/mix` candidate as `getMixableTracks` now returns it: the lean `MixTrack` DTO (no
// finding-only or private fields exist on it) plus the reason chip. A CERTIFIED one carries
// its coordinate; the output schema (`MixCandidateSchema`) drops anything not on this shape.
const CERTIFIED_ITEM = {
  artists: ["Calibre"],
  certified: true,
  durationMs: 300000,
  key: "A minor",
  logId: "004.7.2I",
  spotifyUrl: "https://open.spotify.com/track/x",
  title: "Mr Right On",
  trackId: "track-123",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  getMixableTracks.mockReset();
  getMixableOrder.mockReset();
});

function get(url: string, token?: string): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(url, { headers, method: "GET" });
}

describe("oRPC list_mixable_tracks (GET /tracks/{idOrLogId}/mixable)", () => {
  it("returns the ranked candidates with their reason chip, no auth needed", async () => {
    getMixableTracks.mockResolvedValueOnce([
      { ...CERTIFIED_ITEM, reason: { kind: "key", relationship: "same_key" } },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      get("https://www.fluncle.com/api/v1/tracks/004.7.2I/mixable"),
    );

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as {
      findings: { certified: boolean; logId?: string; reason: unknown }[];
      ok: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.findings[0]?.reason).toEqual({ kind: "key", relationship: "same_key" });
    expect(body.findings[0]?.certified).toBe(true);
    expect(body.findings[0]?.logId).toBe("004.7.2I");
  });

  it("passes the exclude + taste seed through, and clamps the limit in-handler", async () => {
    getMixableTracks.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(
      get(
        "https://www.fluncle.com/api/v1/tracks/004.7.2I/mixable?exclude=004.7.2I,011.1.6E&taste=calibre,lsb&limit=999",
      ),
    );

    expect(getMixableTracks).toHaveBeenCalledWith("004.7.2I", {
      artistSlugs: ["calibre", "lsb"],
      exclude: ["004.7.2I", "011.1.6E"],
      limit: 32, // clamped to MIXABLE_MAX_LIMIT
    });
  });

  // THE UNLIT RULE, enforced at the wire: an uncertified candidate has no coordinate, and the
  // lean `MixTrack` shape has nowhere to put one even if a caller tried. `certified: false`
  // arrives with `logId` absent, so a catalogue row can never be mistaken for a finding.
  it("keeps an uncertified candidate free of a Log ID (the unlit register)", async () => {
    getMixableTracks.mockResolvedValueOnce([
      {
        artists: ["Unknown Artist"],
        certified: false,
        durationMs: 240000,
        reason: { kind: "sonic", relationship: "close_in_sound" },
        spotifyUrl: "https://open.spotify.com/track/y",
        title: "Uncertified Roller",
        trackId: "track-999",
      },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      get("https://www.fluncle.com/api/v1/tracks/004.7.2I/mixable"),
    );
    const body = (await readJson(response)) as {
      findings: (Record<string, unknown> & { certified: boolean })[];
    };

    expect(body.findings[0]?.certified).toBe(false);
    expect(body.findings[0]).not.toHaveProperty("logId");
    expect(body.findings[0]?.reason).toEqual({ kind: "sonic", relationship: "close_in_sound" });
  });
});

describe("oRPC get_mixable_order (GET /admin/tracks/mixable-order)", () => {
  const ORDER = {
    algorithm: "held-karp" as const,
    order: [
      { artists: ["A"], bpm: 174, flagged: false, key: "A minor", logId: "004.7.2I", title: "One" },
      {
        artists: ["B"],
        bpm: 174,
        flagged: false,
        key: "E minor",
        logId: "011.1.6E",
        title: "Two",
        transitionReason: { kind: "key" as const, relationship: "adjacent" as const },
        transitionScore: 0.85,
      },
    ],
    totalCost: 0.15,
  };

  const URL_BASE = "https://www.fluncle.com/api/v1/admin/tracks/mixable-order";

  it("401s without an admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${URL_BASE}?ids=004.7.2I,011.1.6E`));

    expect(response?.status).toBe(401);
    expect(getMixableOrder).not.toHaveBeenCalled();
  });

  it("resolves the STATIC route (not /tracks/{trackId}) and orders for the agent", async () => {
    getMixableOrder.mockResolvedValueOnce(ORDER);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${URL_BASE}?ids=004.7.2I,011.1.6E`, AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(getMixableOrder).toHaveBeenCalledWith(["004.7.2I", "011.1.6E"], {
      seedLogId: undefined,
    });
    const body = (await readJson(response)) as { algorithm: string; ok: boolean };
    expect(body).toMatchObject({ algorithm: "held-karp", ok: true });
  });

  it("passes the seed through", async () => {
    getMixableOrder.mockResolvedValueOnce(ORDER);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get(`${URL_BASE}?ids=004.7.2I,011.1.6E&seed=011.1.6E`, OPERATOR_TOKEN));

    expect(getMixableOrder).toHaveBeenCalledWith(["004.7.2I", "011.1.6E"], {
      seedLogId: "011.1.6E",
    });
  });

  it("400s fewer than 2 ids, more than 64, and a non-Log-ID", async () => {
    const { handleOrpc } = await import("./orpc");

    const one = await handleOrpc(get(`${URL_BASE}?ids=004.7.2I`, AGENT_TOKEN));
    expect(one?.status).toBe(400);

    const tooMany = Array.from({ length: 65 }, () => "004.7.2I").join(",");
    const many = await handleOrpc(get(`${URL_BASE}?ids=${tooMany}`, AGENT_TOKEN));
    expect(many?.status).toBe(400);

    const junk = await handleOrpc(get(`${URL_BASE}?ids=004.7.2I,not-a-coord`, AGENT_TOKEN));
    expect(junk?.status).toBe(400);

    expect(getMixableOrder).not.toHaveBeenCalled();
  });

  it("maps an unresolvable Log ID to a clean 400", async () => {
    const { MixableOrderError } = await import("./tracks");
    getMixableOrder.mockRejectedValueOnce(new MixableOrderError("No finding for 999.9.9Z"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(`${URL_BASE}?ids=004.7.2I,999.9.9Z`, AGENT_TOKEN));

    expect(response?.status).toBe(400);
    const body = (await readJson(response)) as { message?: string };
    expect(body.message).toContain("No finding for");
  });
});
