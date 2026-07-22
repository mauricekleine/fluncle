import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as realApi from "../api";

// The `albums` command is a thin HTTP client over `list_albums` / `get_album`,
// sharing the entity-index rendering with `artists`. These tests cover the
// album-specific bits: the request paths and the release date on the dossier.
let apiResponse: unknown = {};
let lastPath = "";

await mock.module("../api", () => ({
  ...realApi,
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

const { albumsCommand } = await import("./albums");

const LIST = {
  albums: [
    {
      certified: true,
      findingCount: 4,
      name: "Simpler Times",
      slug: "simpler-times",
      trackCount: 9,
    },
    {
      certified: false,
      findingCount: 0,
      name: "Quiet Record",
      slug: "quiet-record",
      trackCount: 1,
    },
  ],
  ok: true,
  page: 1,
  pageCount: 3,
  total: 96,
};

const DETAIL = {
  album: {
    certified: true,
    findingCount: 4,
    name: "Simpler Times",
    releaseDate: "2026-07-18T00:00:00.000Z",
    slug: "simpler-times",
    trackCount: 9,
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

describe("albumsCommand (list)", () => {
  test("rows carry a plain track count; the footer names albums", async () => {
    apiResponse = LIST;
    await albumsCommand({ json: false, page: 1, slug: undefined });

    const text = output();
    expect(lastPath).toBe("/api/v1/albums?page=1");
    expect(text).toContain("Simpler Times");
    expect(text).toContain("9 tracks");
    expect(text).toContain("Page 1 of 3, 96 albums.");
  });

  test("an empty archive says so plainly", async () => {
    apiResponse = { albums: [], ok: true, page: 1, pageCount: 0, total: 0 };
    await albumsCommand({ json: false, page: 1, slug: undefined });

    expect(output()).toBe("No albums in the archive yet.");
  });
});

describe("albumsCommand (detail)", () => {
  test("a slug reads the dossier with the release date (trimmed to the day)", async () => {
    apiResponse = DETAIL;
    await albumsCommand({ json: false, page: 1, slug: "simpler-times" });

    expect(lastPath).toBe("/api/v1/albums/simpler-times");
    const text = output();
    expect(text).toContain("Simpler Times  (simpler-times)");
    expect(text).toContain("Tracks: 9");
    expect(text).toContain("Findings: 4");
    expect(text).toContain("Released: 2026-07-18");
    expect(text).not.toContain("T00:00:00");
  });
});
