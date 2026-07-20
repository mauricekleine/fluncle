import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// The `labels` command is a thin HTTP client over `list_labels` / `get_label`,
// sharing the entity-index rendering with `artists`. These tests cover the
// label-specific bits: the request paths and the home + imprint lines on the
// dossier (the one register where earthly geography is named plainly).
let apiResponse: unknown = {};
let lastPath = "";

await mock.module("../api", () => ({
  publicApiGet: async (path: string) => {
    lastPath = path;
    return apiResponse;
  },
}));

const jsonCalls: unknown[] = [];

await mock.module("../output", () => ({
  printJson: (value: unknown) => {
    jsonCalls.push(value);
  },
}));

const { labelsCommand } = await import("./labels");

const LIST = {
  labels: [
    { certified: true, findingCount: 21, name: "Metalheadz", slug: "metalheadz", trackCount: 60 },
    {
      certified: false,
      findingCount: 0,
      name: "Quiet Imprint",
      slug: "quiet-imprint",
      trackCount: 2,
    },
  ],
  ok: true,
  page: 2,
  pageCount: 5,
  total: 140,
};

const DETAIL = {
  label: {
    certified: true,
    findingCount: 21,
    foundedLocation: "London",
    name: "Metalheadz",
    parentLabel: { name: "Some Parent", slug: "some-parent" },
    slug: "metalheadz",
    trackCount: 60,
  },
  ok: true,
};

let logs: string[] = [];

beforeEach(() => {
  apiResponse = {};
  lastPath = "";
  jsonCalls.length = 0;
  logs = [];
  spyOn(console, "log").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
});

const output = (): string => logs.join("\n");

describe("labelsCommand (list)", () => {
  test("rows carry a plain track count; the footer reflects the page", async () => {
    apiResponse = LIST;
    await labelsCommand({ json: false, page: 2, slug: undefined });

    const text = output();
    expect(lastPath).toBe("/api/v1/labels?page=2");
    expect(text).toContain("Metalheadz");
    expect(text).toContain("60 tracks");
    expect(text).toContain("Page 2 of 5, 140 labels.");
    expect(text).toContain("fluncle labels --page 3");
  });

  test("an empty archive says so plainly", async () => {
    apiResponse = { labels: [], ok: true, page: 1, pageCount: 0, total: 0 };
    await labelsCommand({ json: false, page: 1, slug: undefined });

    expect(output()).toBe("No labels in the archive yet.");
  });
});

describe("labelsCommand (detail)", () => {
  test("a slug reads the dossier with the home and the imprint edge", async () => {
    apiResponse = DETAIL;
    await labelsCommand({ json: false, page: 1, slug: "metalheadz" });

    expect(lastPath).toBe("/api/v1/labels/metalheadz");
    const text = output();
    expect(text).toContain("Metalheadz  (metalheadz)");
    expect(text).toContain("Tracks: 60");
    expect(text).toContain("Findings: 21");
    expect(text).toContain("Based: London");
    expect(text).toContain("Imprint of: Some Parent");
  });
});
