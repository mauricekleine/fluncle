import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// The `fresh` command is a thin HTTP client: it GETs the flat `/tracks/fresh` payload
// (already carrying both `tracks` and `albums`) and CUTS it by `--view`. So the mock
// serves one fixed payload and the assertions ride on how each view shapes the output —
// no grouping is re-done here (the server owns it).
let apiResponse: unknown = { albums: [], tracks: [], windowDays: 30 };

await mock.module("../api", () => ({
  publicApiGet: async () => apiResponse,
}));

const jsonCalls: unknown[] = [];

await mock.module("../output", () => ({
  printJson: (value: unknown) => {
    jsonCalls.push(value);
  },
}));

const { freshCommand } = await import("./fresh");

const FULL = {
  albums: [
    {
      artists: ["Break", "Kyo"],
      name: "Simpler Times",
      releaseDate: "2026-07-18",
      slug: "simpler-times",
    },
  ],
  tracks: [
    {
      artists: ["Halogenix"],
      certified: true,
      logId: "050.7.0A",
      releaseDate: "2026-07-17",
      title: "Lit One",
    },
    {
      artists: ["Unknown Artist"],
      certified: false,
      releaseDate: "2026-07-16",
      title: "Quiet One",
    },
  ],
  windowDays: 30,
};

let logs: string[] = [];

beforeEach(() => {
  apiResponse = { albums: [], tracks: [], windowDays: 30 };
  jsonCalls.length = 0;
  logs = [];
  spyOn(console, "log").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
});

const output = (): string => logs.join("\n");

describe("freshCommand --view (human table)", () => {
  test("tracks: only the release stream, bare (no heading)", async () => {
    apiResponse = FULL;
    await freshCommand({ json: false, limit: 50, view: "tracks" });

    const text = output();
    expect(text).toContain("050.7.0A");
    expect(text).toContain("Lit One");
    expect(text).toContain("Quiet One");
    // A single view names itself via the flag — no section heading, and no records leak in.
    expect(text).not.toContain("Albums & EPs");
    expect(text).not.toContain("Simpler Times");
  });

  test("albums: only the records, named and coordinate-free (the Unlit Rule)", async () => {
    apiResponse = FULL;
    await freshCommand({ json: false, limit: 50, view: "albums" });

    const text = output();
    expect(text).toContain("Simpler Times");
    expect(text).toContain("Break, Kyo");
    // No coordinate on a record, and the track stream is dropped.
    expect(text).not.toContain("050.7.0A");
    expect(text).not.toContain("Lit One");
  });

  test("all (default cut): both blocks, each headed to tell them apart", async () => {
    apiResponse = FULL;
    await freshCommand({ json: false, limit: 50, view: "all" });

    const text = output();
    expect(text).toContain("Tracks");
    expect(text).toContain("Albums & EPs");
    expect(text).toContain("Lit One");
    expect(text).toContain("Simpler Times");
  });

  test("an empty window says so, whatever the view", async () => {
    await freshCommand({ json: false, limit: 50, view: "all" });

    expect(output()).toBe("Nothing new out in the last 30 days.");
  });
});

describe("freshCommand --view (--json cut)", () => {
  test("all keeps the full payload (backwards-compatible)", async () => {
    apiResponse = FULL;
    await freshCommand({ json: true, limit: 50, view: "all" });

    const payload = jsonCalls[0] as {
      albums?: unknown[];
      ok: boolean;
      tracks?: unknown[];
      windowDays: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.windowDays).toBe(30);
    expect(payload.tracks).toHaveLength(2);
    expect(payload.albums).toHaveLength(1);
  });

  test("tracks drops the albums bucket", async () => {
    apiResponse = FULL;
    await freshCommand({ json: true, limit: 50, view: "tracks" });

    const payload = jsonCalls[0] as { albums?: unknown[]; tracks?: unknown[] };
    expect(payload.tracks).toHaveLength(2);
    expect(payload.albums).toBeUndefined();
  });

  test("albums drops the tracks bucket", async () => {
    apiResponse = FULL;
    await freshCommand({ json: true, limit: 50, view: "albums" });

    const payload = jsonCalls[0] as { albums?: unknown[]; tracks?: unknown[] };
    expect(payload.albums).toHaveLength(1);
    expect(payload.tracks).toBeUndefined();
  });
});
