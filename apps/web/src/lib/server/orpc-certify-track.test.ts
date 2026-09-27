import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_MAX_LENGTH } from "../log-prose";
import { OPERATOR_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const certifyExistingTrack = vi.fn();
const syncTelescopePlaylist = vi.fn();

vi.mock("./publish", () => ({
  certifyExistingTrack: (...args: unknown[]) => certifyExistingTrack(...args),
}));

vi.mock("./telescope-playlist", () => ({
  syncTelescopePlaylist: () => syncTelescopePlaylist(),
}));

const PATH = "/admin/catalogue/certify";
const TRACK_ID = "catalogue-track-1";

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  certifyExistingTrack.mockReset().mockResolvedValue({ logId: "004.7.2I" });
  syncTelescopePlaylist.mockReset().mockResolvedValue(undefined);
});

describe("oRPC certify_track (POST /admin/catalogue/certify)", () => {
  it("passes a note at the public budget through trimmed", async () => {
    const note = "x".repeat(NOTE_MAX_LENGTH);
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", OPERATOR_TOKEN, { note: `  ${note}  `, trackId: TRACK_ID }),
    );

    expect(response?.status).toBe(200);
    expect(certifyExistingTrack).toHaveBeenCalledWith(TRACK_ID, { note });
  });

  it("422s `note_too_long` one past the public budget and certifies nothing", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", OPERATOR_TOKEN, {
        note: "x".repeat(NOTE_MAX_LENGTH + 1),
        trackId: TRACK_ID,
      }),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("note_too_long");
    expect(certifyExistingTrack).not.toHaveBeenCalled();
  });

  it("certifies without a note when the note is blank", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", OPERATOR_TOKEN, { note: "   ", trackId: TRACK_ID }),
    );

    expect(response?.status).toBe(200);
    expect(certifyExistingTrack).toHaveBeenCalledWith(TRACK_ID, { note: undefined });
  });
});
