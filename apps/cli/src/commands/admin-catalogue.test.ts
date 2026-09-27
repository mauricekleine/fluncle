import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

let posts: Array<{ body: unknown; path: string }> = [];

await mock.module("../api", () => ({
  ...realApi,
  adminApiPost: async (path: string, body?: unknown) => {
    posts.push({ body, path });
    return { ok: true, paidCleared: 1, requeued: 1 };
  },
}));

const { requeueAnchorCommand } = await import("./admin-catalogue");

beforeEach(() => {
  posts = [];
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
