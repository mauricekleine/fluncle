import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The `anchor_track` handler, driven end-to-end through `handleOrpc` against
// `/api/v1/admin/catalogue/anchor`, so the REAL admin auth spine runs and the box's agent token is
// proven to pass (it is agent tier). Only the anchor SERVICE (`../anchor`) is mocked — this suite
// proves the HANDLER's own logic: candidate normalisation (uri/url → a bare Spotify id) and the
// `AnchorTrackError` → HTTP status mapping (404 / 409). The verification + write are proven for real
// against the schema in anchor.integration.test.ts.

const anchorTrackMock = vi.fn();

vi.mock("./anchor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./anchor")>();

  // Keep AnchorTrackError REAL (the handler's `instanceof` must match), stub only anchorTrack.
  return { ...actual, anchorTrack: (...args: unknown[]) => anchorTrackMock(...args) };
});

const PATH = "/admin/catalogue/anchor";

beforeAll(() => {
  setAdminTokenEnv();
});

beforeEach(() => {
  anchorTrackMock.mockReset();
});

describe("oRPC anchor_track (POST /admin/catalogue/anchor)", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", undefined, { candidates: [], trackId: "mb_x" }),
    );

    expect(response?.status).toBe(401);
    expect(anchorTrackMock).not.toHaveBeenCalled();
  });

  it("lets the AGENT token anchor and returns the verdict envelope", async () => {
    anchorTrackMock.mockResolvedValueOnce({ anchored: true, verifiedBy: "isrc" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, {
        candidates: [
          {
            artists: [{ id: "sp-1", name: "Etherwood" }],
            durationMs: 261_000,
            isrc: "GBCJY1300173",
            spotifyTrackId: "spot001",
            title: "Weightless",
          },
        ],
        trackId: "mb_rec-1",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ anchored: true, ok: true, verifiedBy: "isrc" });
    expect(anchorTrackMock).toHaveBeenCalledWith("mb_rec-1", [
      expect.objectContaining({
        isrc: "GBCJY1300173",
        spotifyTrackId: "spot001",
        title: "Weightless",
      }),
    ]);
  });

  it("normalises a candidate's uri/url to a bare Spotify id", async () => {
    anchorTrackMock.mockResolvedValueOnce({ anchored: false, verifiedBy: null });

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, {
        candidates: [
          { artists: [], title: "From URI", uri: "spotify:track:fromUri01" },
          {
            artists: [],
            title: "From URL",
            url: "https://open.spotify.com/track/fromUrl02?si=abc",
          },
        ],
        trackId: "mb_norm",
      }),
    );

    const passed = anchorTrackMock.mock.calls[0]?.[1] as { spotifyTrackId: string }[];
    expect(passed.map((candidate) => candidate.spotifyTrackId)).toEqual(["fromUri01", "fromUrl02"]);
  });

  it("rejects a candidate carrying none of spotifyTrackId/uri/url at the boundary (the refine)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, {
        candidates: [{ artists: [], title: "No id at all" }],
        trackId: "mb_bad",
      }),
    );

    // A malformed candidate is a 400 at the contract boundary — never silently dropped, and the
    // service is never reached.
    expect(response?.status).toBe(400);
    expect(anchorTrackMock).not.toHaveBeenCalled();
  });

  it("maps not_found → 404", async () => {
    const { AnchorTrackError } = await import("./anchor");
    anchorTrackMock.mockRejectedValueOnce(
      new AnchorTrackError("not_found", "No track with id mb_x"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, { candidates: [], trackId: "mb_x" }),
    );

    expect(response?.status).toBe(404);
  });

  it("maps certified → 409", async () => {
    const { AnchorTrackError } = await import("./anchor");
    anchorTrackMock.mockRejectedValueOnce(new AnchorTrackError("certified", "Track is certified"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, { candidates: [], trackId: "spotifyFinding" }),
    );

    expect(response?.status).toBe(409);
  });

  it("maps already_anchored → 409", async () => {
    const { AnchorTrackError } = await import("./anchor");
    anchorTrackMock.mockRejectedValueOnce(
      new AnchorTrackError("already_anchored", "Track already carries a Spotify anchor"),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, { candidates: [], trackId: "mb_x" }),
    );

    expect(response?.status).toBe(409);
  });
});
