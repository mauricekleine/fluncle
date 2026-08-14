import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const addArtistRule = vi.hoisted(() => vi.fn());
const replaceLabelArtistRules = vi.hoisted(() => vi.fn());
const updateArtistRule = vi.hoisted(() => vi.fn());

vi.mock("./artist-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artist-rules")>();

  return { ...actual, addArtistRule, replaceLabelArtistRules, updateArtistRule };
});

beforeAll(setAdminTokenEnv);

warmOrpcRouter();
beforeEach(() => vi.clearAllMocks());

describe("add_artist_rule — POST /admin/artist-rules", () => {
  it("returns 409 when the global MBID already has a rule", async () => {
    const { DuplicateGlobalArtistRuleError } = await import("./artist-rules");
    addArtistRule.mockRejectedValueOnce(
      new DuplicateGlobalArtistRuleError(
        "A global artist rule already exists for 12345678-1234-4234-8234-123456789abc.",
      ),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artist-rules", "POST", OPERATOR_TOKEN, {
        artistMbid: "12345678-1234-4234-8234-123456789abc",
        artistName: "Test Artist",
        verdict: "allow",
      }),
    );

    expect(response?.status).toBe(409);
    expect(await readJson(response)).toEqual({
      code: "artist_rule_exists",
      message: "A global artist rule already exists for 12345678-1234-4234-8234-123456789abc.",
      ok: false,
    });
  });
});

describe("update_artist_rule — PATCH /admin/artist-rules/{id}", () => {
  it("writes only the supplied drift stamps through the globally addressed op", async () => {
    updateArtistRule.mockResolvedValueOnce({
      artistMbid: "12345678-1234-4234-8234-123456789abc",
      artistName: "Requested Artist",
      artistSpotifyId: null,
      checkedAt: "2026-08-02T12:34:56.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      id: "arl_test",
      resolvedMbid: "87654321-4321-4321-8321-cba987654321",
      resolvedName: "Resolved Artist",
      updatedAt: "2026-08-02T12:34:56.000Z",
      verdict: "block",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artist-rules/arl_test", "PATCH", OPERATOR_TOKEN, {
        checkedAt: "2026-08-02T12:34:56.000Z",
        resolvedMbid: "87654321-4321-4321-8321-cba987654321",
        resolvedName: "Resolved Artist",
      }),
    );

    expect(response?.status).toBe(200);
    expect(updateArtistRule).toHaveBeenCalledWith("arl_test", {
      checkedAt: "2026-08-02T12:34:56.000Z",
      resolvedMbid: "87654321-4321-4321-8321-cba987654321",
      resolvedName: "Resolved Artist",
    });
  });

  it("returns 404 for an unknown global or per-label rule id", async () => {
    const { ArtistRuleNotFoundError } = await import("./artist-rules");
    updateArtistRule.mockRejectedValueOnce(
      new ArtistRuleNotFoundError("No artist rule with id arl_missing."),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artist-rules/arl_missing", "PATCH", OPERATOR_TOKEN, {
        checkedAt: "2026-08-02T12:34:56.000Z",
      }),
    );

    expect(response?.status).toBe(404);
  });

  it("rejects an empty drift stamp at the contract boundary", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/artist-rules/arl_test", "PATCH", OPERATOR_TOKEN, {}),
    );

    expect(response?.status).toBe(400);
    expect(updateArtistRule).not.toHaveBeenCalled();
  });
});

describe("replace_label_artist_rules — PUT /admin/labels/{id}/artists", () => {
  it.each([
    ["triage", "triage"],
    [undefined, "operator"],
  ] as const)("threads source %s as %s", async (source, expectedSource) => {
    replaceLabelArtistRules.mockResolvedValueOnce([]);
    const { handleOrpc } = await import("./orpc");
    const body = {
      rules: [
        {
          artistMbid: "12345678-1234-4234-8234-123456789abc",
          artistName: "Test Artist",
          verdict: "block",
        },
      ],
      ...(source === undefined ? {} : { source }),
    };
    const response = await handleOrpc(
      req("/admin/labels/lbl_test/artists", "PUT", OPERATOR_TOKEN, body),
    );

    expect(response?.status).toBe(200);
    expect(replaceLabelArtistRules).toHaveBeenCalledWith("lbl_test", body.rules, expectedSource);
  });
});
