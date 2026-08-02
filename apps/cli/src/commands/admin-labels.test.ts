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

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async () => ({ labels: [label], ok: true }),
  adminApiPatch: async (path: string, body: unknown) => {
    patches.push({ body, path });

    return { label, ok: true };
  },
}));

const { updateLabelCommand } = await import("./admin-labels");

beforeEach(() => {
  patches = [];
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
