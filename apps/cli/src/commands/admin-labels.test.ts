import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

const label = {
  createdAt: "2026-08-01T00:00:00.000Z",
  findingCount: 0,
  id: "lbl_test",
  name: "Test Label",
  ruledAt: null,
  scopeChangedAt: null,
  seedState: "undecided" as const,
  slug: "test-label",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

let patches: Array<{ body: unknown; path: string }> = [];
let gets: string[] = [];
let posts: Array<{ body: unknown; path: string }> = [];
let puts: Array<{ body: unknown; path: string }> = [];

const artistRule = {
  artistMbid: "12345678-1234-1234-1234-123456789abc",
  artistName: "Test Artist",
  artistSpotifyId: null,
  checkedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  id: "arl_test",
  resolvedMbid: null,
  resolvedName: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  verdict: "allow" as const,
};

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    gets.push(path);
    return path === "/api/v1/admin/labels"
      ? { labels: [label], ok: true }
      : { ok: true, rules: [artistRule] };
  },
  adminApiPatch: async (path: string, body: unknown) => {
    patches.push({ body, path });

    return { label, ok: true };
  },
  adminApiPost: async (path: string, body: unknown) => {
    posts.push({ body, path });

    return { label, ok: true, outcome: "minted" };
  },
  adminApiPut: async (path: string, body: unknown) => {
    puts.push({ body, path });
    return { ok: true, rules: [artistRule] };
  },
}));

const {
  listLabelArtistRulesCommand,
  mintLabelCommand,
  parseLabelArtistRulesJson,
  replaceLabelArtistRulesCommand,
  updateLabelCommand,
} = await import("./admin-labels");

beforeEach(() => {
  gets = [];
  patches = [];
  posts = [];
  puts = [];
});

describe("updateLabelCommand", () => {
  test("keeps seed-only, re-walk-only, and combined PATCH bodies distinct", async () => {
    await updateLabelCommand("test-label", "enabled");
    await updateLabelCommand("test-label", undefined, true);
    await updateLabelCommand("lbl_test", "disabled", true);

    expect(patches).toEqual([
      {
        body: { seedState: "enabled" },
        path: "/api/v1/admin/labels/lbl_test",
      },
      {
        body: { rewalk: true },
        path: "/api/v1/admin/labels/lbl_test",
      },
      {
        body: { rewalk: true, seedState: "disabled" },
        path: "/api/v1/admin/labels/lbl_test",
      },
    ]);
  });
});

describe("mintLabelCommand", () => {
  test("posts the MBID alone, adds a ruling only when one is given, and makes no seed-set round trip", async () => {
    await mintLabelCommand("4CBB2BA1-4E0A-4A6E-8F3D-5E17A4C0A1F2");
    const ruled = await mintLabelCommand("4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2", "enabled");

    expect(posts).toEqual([
      {
        body: { mbLabelId: "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2" },
        path: "/api/v1/admin/labels",
      },
      {
        body: { mbLabelId: "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2", seedState: "enabled" },
        path: "/api/v1/admin/labels",
      },
    ]);
    // The op is keyed by the MusicBrainz identity, so there is no Fluncle id to resolve first.
    expect(gets).toEqual([]);
    expect(ruled.outcome).toBe("minted");
  });

  test("passes the take-over slug straight through, normalized, and omits it otherwise", async () => {
    await mintLabelCommand("4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2", undefined, "  Med-School ");

    // The SERVER decides whether that row is the one the mint collided with and whether it may
    // give up its identity, so the CLI resolves nothing and spends no seed-set read.
    expect(posts).toEqual([
      {
        body: {
          mbLabelId: "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2",
          takeOverSlug: "med-school",
        },
        path: "/api/v1/admin/labels",
      },
    ]);
    expect(gets).toEqual([]);
  });

  test("refuses a value that is not a MusicBrainz MBID before spending a request", async () => {
    let message = "";

    try {
      await mintLabelCommand("med-school");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("MusicBrainz label MBID");
    expect(posts).toEqual([]);
  });
});

describe("label artist rules", () => {
  test("resolves a slug through the label list before reading or replacing rules", async () => {
    const listed = await listLabelArtistRulesCommand("test-label");
    const replaced = await replaceLabelArtistRulesCommand("lbl_test", [
      {
        artistMbid: artistRule.artistMbid,
        artistName: artistRule.artistName,
        verdict: "allow",
      },
    ]);

    expect(gets).toEqual([
      "/api/v1/admin/labels",
      "/api/v1/admin/labels/lbl_test/artists",
      "/api/v1/admin/labels",
    ]);
    expect(puts).toEqual([
      {
        body: {
          rules: [
            {
              artistMbid: artistRule.artistMbid,
              artistName: artistRule.artistName,
              verdict: "allow",
            },
          ],
        },
        path: "/api/v1/admin/labels/lbl_test/artists",
      },
    ]);
    expect(listed.rules).toEqual([artistRule]);
    expect(replaced.label.slug).toBe("test-label");
  });

  test("parses, trims, normalizes, and validates the complete JSON array before mutation", () => {
    expect(
      parseLabelArtistRulesJson(
        JSON.stringify([
          {
            artistMbid: "12345678-1234-1234-1234-123456789ABC",
            artistName: "  Test Artist  ",
            verdict: "block",
          },
        ]),
      ),
    ).toEqual([
      {
        artistMbid: "12345678-1234-1234-1234-123456789abc",
        artistName: "Test Artist",
        verdict: "block",
      },
    ]);

    expect(() => parseLabelArtistRulesJson("not json")).toThrow("valid JSON");
    expect(() => parseLabelArtistRulesJson("{}")).toThrow("JSON array");
    expect(() => parseLabelArtistRulesJson(JSON.stringify(Array.from({ length: 101 })))).toThrow(
      "at most 100",
    );
    expect(() =>
      parseLabelArtistRulesJson(
        JSON.stringify([{ artistMbid: "not-an-mbid", artistName: "Test", verdict: "allow" }]),
      ),
    ).toThrow("MusicBrainz artist MBID");
    expect(() =>
      parseLabelArtistRulesJson(
        JSON.stringify([
          {
            artistMbid: artistRule.artistMbid,
            artistName: " ",
            verdict: "allow",
          },
        ]),
      ),
    ).toThrow("non-empty string");
    expect(() =>
      parseLabelArtistRulesJson(
        JSON.stringify([
          {
            artistMbid: artistRule.artistMbid,
            artistName: "Test",
            verdict: "skip",
          },
        ]),
      ),
    ).toThrow("'allow' or 'block'");
  });
});
