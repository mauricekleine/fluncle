import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

let posts: Array<{ body: unknown; path: string }> = [];
let gets: string[] = [];

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    gets.push(path);
    return { summary: {}, tracks: [] };
  },
  adminApiPost: async (path: string, body?: unknown) => {
    posts.push({ body, path });
    return { ok: true, paidCleared: 1, requeued: 1 };
  },
}));

const { catalogueListCommand, requeueAnchorCommand } = await import("./admin-catalogue");

beforeEach(() => {
  gets = [];
  posts = [];
});

describe("catalogue list lenses", () => {
  test("passes every contract lens through, long included, and defaults to ear", async () => {
    await catalogueListCommand({ lens: "long", limit: "5" });
    await catalogueListCommand({});

    expect(gets).toEqual([
      "/api/v1/admin/catalogue?lens=long&limit=5",
      "/api/v1/admin/catalogue?lens=ear",
    ]);
  });

  test("rejects an unknown lens instead of quietly listing ear", async () => {
    await expect(catalogueListCommand({ lens: "eer" })).rejects.toThrow(/Unknown lens "eer"/);
    expect(gets).toEqual([]);
  });
});

describe("anchor paid receipt reconciliation", () => {
  test("keeps receipt settlement an explicit operator choice", async () => {
    await requeueAnchorCommand(["track-a"]);
    await requeueAnchorCommand(["track-b"], true);

    expect(posts).toEqual([
      {
        body: { clearPaid: false, trackIds: ["track-a"] },
        path: "/api/v1/admin/catalogue/anchor/requeue",
      },
      {
        body: { clearPaid: true, trackIds: ["track-b"] },
        path: "/api/v1/admin/catalogue/anchor/requeue",
      },
    ]);
  });
});
