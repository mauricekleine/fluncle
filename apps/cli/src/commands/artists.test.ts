import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as realApi from "../api";

// The `artists` command is a thin HTTP client over `list_artists` / `get_artist`.
// The mock keys off the request path: the by-slug detail path returns one artist,
// the list path returns the paginated envelope. Assertions ride on how each cut
// shapes the output — plain track counts on list rows (the Unlit Rule), the
// dossier on a detail read.
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

const { artistsCommand } = await import("./artists");

const LIST = {
  artists: [
    { certified: true, findingCount: 12, name: "Break", slug: "break", trackCount: 47 },
    { certified: false, findingCount: 0, name: "Quiet One", slug: "quiet-one", trackCount: 3 },
  ],
  ok: true,
  page: 1,
  pageCount: 8,
  total: 312,
};

const DETAIL = {
  artist: {
    certified: true,
    findingCount: 12,
    name: "Break",
    slug: "break",
    spotifyUrl: "https://open.spotify.com/artist/break",
    trackCount: 47,
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

describe("artistsCommand (list)", () => {
  test("rows carry a plain track count, never a tier marker (the Unlit Rule)", async () => {
    apiResponse = LIST;
    await artistsCommand({ json: false, page: 1, slug: undefined });

    const text = output();
    expect(text).toContain("Break");
    expect(text).toContain("47 tracks");
    expect(text).toContain("Quiet One");
    expect(text).toContain("3 tracks");
    // No certified / finding label leaks onto a list row.
    expect(text).not.toContain("certified");
    expect(text).not.toContain("finding");
  });

  test("a multi-page list prints a footer with the next-page hint", async () => {
    apiResponse = LIST;
    await artistsCommand({ json: false, page: 1, slug: undefined });

    const text = output();
    expect(text).toContain("Page 1 of 8, 312 artists.");
    expect(text).toContain("fluncle artists --page 2");
  });

  test("--page rides through to the request", async () => {
    apiResponse = { ...LIST, page: 3 };
    await artistsCommand({ json: false, page: 3, slug: undefined });

    expect(lastPath).toBe("/api/v1/artists?page=3");
  });

  test("--json passes the whole envelope through (page metadata included)", async () => {
    apiResponse = LIST;
    await artistsCommand({ json: true, page: 1, slug: undefined });

    const payload = jsonCalls[0] as { artists: unknown[]; pageCount: number; total: number };
    expect(payload.artists).toHaveLength(2);
    expect(payload.pageCount).toBe(8);
    expect(payload.total).toBe(312);
  });

  test("an empty archive says so plainly", async () => {
    apiResponse = { artists: [], ok: true, page: 1, pageCount: 0, total: 0 };
    await artistsCommand({ json: false, page: 1, slug: undefined });

    expect(output()).toBe("No artists in the archive yet.");
  });

  test("an empty page past the end points back at the real total", async () => {
    apiResponse = { artists: [], ok: true, page: 99, pageCount: 8, total: 312 };
    await artistsCommand({ json: false, page: 99, slug: undefined });

    expect(output()).toContain("Nothing on page 99");
    expect(output()).toContain("312 artists across 8 pages");
  });
});

describe("artistsCommand (detail)", () => {
  test("a slug reads the dossier: counts plus the Spotify link", async () => {
    apiResponse = DETAIL;
    await artistsCommand({ json: false, page: 1, slug: "break" });

    expect(lastPath).toBe("/api/v1/artists/break");
    const text = output();
    expect(text).toContain("Break  (break)");
    expect(text).toContain("Tracks: 47");
    expect(text).toContain("Findings: 12");
    expect(text).toContain("Spotify: https://open.spotify.com/artist/break");
  });

  test("--json passes the detail envelope through", async () => {
    apiResponse = DETAIL;
    await artistsCommand({ json: true, page: 1, slug: "break" });

    const payload = jsonCalls[0] as { artist: { slug: string } };
    expect(payload.artist.slug).toBe("break");
  });
});
