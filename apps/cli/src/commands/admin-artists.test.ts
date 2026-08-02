import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

const rule = {
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

let deletes: string[] = [];
let gets: string[] = [];
let posts: Array<{ body: unknown; path: string }> = [];

await mock.module("../api", () => ({
  ...realApi,
  adminApiDelete: async (path: string) => {
    deletes.push(path);
    return { ok: true };
  },
  adminApiGet: async (path: string) => {
    gets.push(path);
    return { ok: true, rules: [rule] };
  },
  adminApiPost: async (path: string, body: unknown) => {
    posts.push({ body, path });
    return { ok: true, rule };
  },
}));

const { addArtistRuleCommand, artistRuleInput, listArtistRulesCommand, removeArtistRuleCommand } =
  await import("./admin-artists");

beforeEach(() => {
  deletes = [];
  gets = [];
  posts = [];
});

describe("global artist rules", () => {
  test("validates the MBID, verdict, and optional name before building the request", () => {
    expect(
      artistRuleInput("12345678-1234-1234-1234-123456789ABC", "allow", "  Test Artist  "),
    ).toEqual({
      artistMbid: rule.artistMbid,
      artistName: "Test Artist",
      verdict: "allow",
    });
    expect(artistRuleInput(rule.artistMbid, "block")).toEqual({
      artistMbid: rule.artistMbid,
      verdict: "block",
    });
    expect(() => artistRuleInput("nope", "allow")).toThrow("MusicBrainz artist MBID");
    expect(() => artistRuleInput(rule.artistMbid, "skip")).toThrow("allow|block");
    expect(() => artistRuleInput(rule.artistMbid, "allow", " ")).toThrow("non-empty");
  });

  test("omits artistName when absent and uses the global rule routes", async () => {
    await listArtistRulesCommand();
    await addArtistRuleCommand(artistRuleInput(rule.artistMbid, "allow"));
    await removeArtistRuleCommand("arl_test/unsafe");

    expect(gets).toEqual(["/api/v1/admin/artist-rules"]);
    expect(posts).toEqual([
      {
        body: { artistMbid: rule.artistMbid, verdict: "allow" },
        path: "/api/v1/admin/artist-rules",
      },
    ]);
    expect(deletes).toEqual(["/api/v1/admin/artist-rules/arl_test%2Funsafe"]);
  });
});
