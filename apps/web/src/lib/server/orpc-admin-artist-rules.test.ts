import { beforeAll, describe, expect, it, vi } from "vitest";
import { OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

const addArtistRule = vi.hoisted(() => vi.fn());

vi.mock("./artist-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artist-rules")>();

  return { ...actual, addArtistRule };
});

beforeAll(setAdminTokenEnv);

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
