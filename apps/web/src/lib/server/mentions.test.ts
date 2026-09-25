import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => ({ execute: (...args: unknown[]) => execute(...args) }),
}));

vi.mock("./log", () => ({ logEvent: vi.fn() }));

import {
  captionForPlatform,
  captionWithMentions,
  injectMentionLine,
  MAX_MENTION_HANDLES,
  mentionHandlesFor,
  parseMentionHandle,
} from "./mentions";

const CAPTION =
  "Indivision — Don't Leave Me This Way (2020)\n" +
  "Indivision Music\n" +
  "\n" +
  "Found Jun 26: fluncle://027.9.5H\n" +
  "\n" +
  "#dnb #drumnbass #drumandbass\n";

const CAPTION_NO_LABEL =
  "Indivision — Don't Leave Me This Way (2020)\n" +
  "\n" +
  "Found Jun 26: fluncle://027.9.5H\n" +
  "\n" +
  "#dnb #drumnbass #drumandbass\n";

describe("parseMentionHandle", () => {
  const cases: Array<{ name: string; url: string; expected: string | undefined }> = [
    {
      expected: "@indivisionmusic",
      name: "youtube /@handle",
      url: "https://www.youtube.com/@indivisionmusic",
    },
    {
      expected: "@indivisionmusic",
      name: "youtube /@handle with trailing path",
      url: "https://www.youtube.com/@indivisionmusic/videos",
    },
    {
      expected: undefined,
      name: "youtube /channel/UC… (unusable)",
      url: "https://www.youtube.com/channel/UCabcdef3456",
    },
    {
      expected: undefined,
      name: "youtube /c/… (unusable)",
      url: "https://www.youtube.com/c/Indivision",
    },
    {
      expected: undefined,
      name: "youtube /user/… (unusable)",
      url: "https://www.youtube.com/user/indivision",
    },
    { expected: "@fluncle", name: "tiktok /@handle", url: "https://www.tiktok.com/@fluncle" },
    {
      expected: "@dj.some_one",
      name: "tiktok /@handle with dots/underscores",
      url: "https://www.tiktok.com/@dj.some_one",
    },
    { expected: undefined, name: "bare host, no path", url: "https://www.youtube.com/" },
    { expected: undefined, name: "not a url", url: "not a url" },
    { expected: undefined, name: "empty", url: "" },
  ];

  for (const { name, url, expected } of cases) {
    // oxlint-disable-next-line vitest/valid-title -- parameterized: `name` is a string from the typed cases table
    it(name, () => {
      expect(parseMentionHandle(url)).toBe(expected);
    });
  }
});

describe("injectMentionLine", () => {
  it("inserts a single handle line right under the label", () => {
    const out = injectMentionLine(CAPTION, ["@indivisionmusic"]);

    expect(out).toBe(
      "Indivision — Don't Leave Me This Way (2020)\n" +
        "Indivision Music\n" +
        "@indivisionmusic\n" +
        "\n" +
        "Found Jun 26: fluncle://027.9.5H\n" +
        "\n" +
        "#dnb #drumnbass #drumandbass\n",
    );
  });

  it("joins multiple handles onto one credit line, primary first", () => {
    const out = injectMentionLine(CAPTION, ["@one", "@two"]).split("\n");

    expect(out[1]).toBe("Indivision Music");
    expect(out[2]).toBe("@one @two");
    expect(out[3]).toBe("");
  });

  it("inserts right under the title when there is no label", () => {
    const out = injectMentionLine(CAPTION_NO_LABEL, ["@one"]).split("\n");

    expect(out[0]).toBe("Indivision — Don't Leave Me This Way (2020)");
    expect(out[1]).toBe("@one");
    expect(out[2]).toBe("");
  });

  it("returns the caption byte-identical when there are no handles", () => {
    expect(injectMentionLine(CAPTION, [])).toBe(CAPTION);
  });

  it("leaves an unrecognized caption shape untouched (never mangles it)", () => {
    const weird = "just one line, no blank, no coordinate";
    expect(injectMentionLine(weird, ["@one"])).toBe(weird);
  });
});

describe("captionWithMentions", () => {
  it("keeps all handles when they fit under the cap", () => {
    const out = captionWithMentions(CAPTION, ["@one", "@two", "@three"], 5000);
    expect(out).toContain("@one @two @three");
  });

  it("drops handles LAST-ARTIST-FIRST until the caption fits", () => {
    const withOne = injectMentionLine(CAPTION, ["@one"]);
    const cap = withOne.length;
    const out = captionWithMentions(CAPTION, ["@one", "@two", "@three"], cap);

    expect(out).toBe(withOne);
    expect(out).toContain("@one");
    expect(out).not.toContain("@two");
  });

  it("returns the bare caption (never truncates identity/Found/tags) when even it exceeds the cap", () => {
    const out = captionWithMentions(CAPTION, ["@one"], 5);

    expect(out).toBe(CAPTION);

    expect(out).toContain("fluncle://027.9.5H");
    expect(out).toContain("#dnb #drumnbass #drumandbass");
  });
});

describe("mentionHandlesFor", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("selects lead artists (role null), trust-gated, ordered by position — encoded in the SQL", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    await mentionHandlesFor("t1", "youtube");

    const call = execute.mock.calls[0]?.[0] as { args: unknown[]; sql: string };
    expect(call.args).toEqual(["t1", "youtube"]);

    expect(call.sql).toContain("ta.role is null");
    expect(call.sql).toContain("status in ('auto', 'confirmed')");
    expect(call.sql).toContain("order by ta.position asc");
  });

  it("parses usable handles, skips unusable rows, and dedupes", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { url: "https://www.youtube.com/@one" },
        { url: "https://www.youtube.com/channel/UCxyz" },
        { url: "https://www.youtube.com/@one" },
        { url: "https://www.youtube.com/@two" },
      ],
    });

    expect(await mentionHandlesFor("t1", "youtube")).toEqual(["@one", "@two"]);
  });

  it(`caps at ${MAX_MENTION_HANDLES} handles`, async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { url: "https://www.tiktok.com/@a" },
        { url: "https://www.tiktok.com/@b" },
        { url: "https://www.tiktok.com/@c" },
        { url: "https://www.tiktok.com/@d" },
      ],
    });

    const handles = await mentionHandlesFor("t1", "tiktok");
    expect(handles).toEqual(["@a", "@b", "@c"]);
    expect(handles).toHaveLength(MAX_MENTION_HANDLES);
  });

  it("returns [] (never throws) when the DB read fails — a lookup never blocks a push", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));

    expect(await mentionHandlesFor("t1", "youtube")).toEqual([]);
  });
});

describe("captionForPlatform", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("weaves the platform's handles in under the cap", async () => {
    execute.mockResolvedValueOnce({ rows: [{ url: "https://www.tiktok.com/@fluncle" }] });

    const out = await captionForPlatform("t1", "tiktok", CAPTION);
    expect(out).toContain("@fluncle");
  });

  it("returns the caption byte-identical when no trusted handle exists", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    expect(await captionForPlatform("t1", "youtube", CAPTION)).toBe(CAPTION);
  });

  it("no-ops (no DB read) on an empty caption or a missing trackId", async () => {
    expect(await captionForPlatform("t1", "tiktok", "")).toBe("");
    expect(await captionForPlatform("", "tiktok", CAPTION)).toBe(CAPTION);
    expect(execute).not.toHaveBeenCalled();
  });
});
