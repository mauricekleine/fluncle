import { describe, expect, it } from "vitest";
import { checkYoutubeOfficial, isOfficialAuthor, isTopicChannel } from "./youtube-official";

describe("isTopicChannel — YouTube's auto-generated art-track channels", () => {
  it("recognizes a `<Artist> - Topic` channel whatever the spacing", () => {
    expect(isTopicChannel("Netsky - Topic")).toBe(true);
    expect(isTopicChannel("Chase & Status-Topic")).toBe(true);
    expect(isTopicChannel("  Sub Focus - Topic  ")).toBe(true);
  });

  it("does not fire on a channel that merely contains the word", () => {
    expect(isTopicChannel("Hot Topic Records")).toBe(false);
    expect(isTopicChannel("Topical News Network")).toBe(false);
    expect(isTopicChannel("UKF Drum & Bass")).toBe(false);
  });
});

describe("isOfficialAuthor — the permission, not the identity", () => {
  it("accepts an art-track channel regardless of who is credited", () => {
    // The Topic channel IS the rights-holder's delivered audio, so it needs no name agreement.
    expect(isOfficialAuthor("Some Artist - Topic", [])).toBe(true);
    expect(isOfficialAuthor("Netsky - Topic", ["Someone Else"])).toBe(true);
  });

  it("accepts the artist's own channel on folded equality", () => {
    expect(isOfficialAuthor("Netsky", ["Netsky"])).toBe(true);
    expect(isOfficialAuthor("netsky", ["Netsky"])).toBe(true);
    // The house fold meets `&` with `and`, and strips accents.
    expect(isOfficialAuthor("Chase and Status", ["Chase & Status"])).toBe(true);
    expect(isOfficialAuthor("Noisia", ["Noïsia"])).toBe(true);
  });

  it("accepts when any one credited artist matches", () => {
    expect(isOfficialAuthor("Halogenix", ["Alix Perez", "Halogenix"])).toBe(true);
  });

  it("REFUSES a channel that merely embeds an artist's name", () => {
    // The whole reason this is equality and not containment: a rip channel names the artist too.
    expect(isOfficialAuthor("Netsky Fan Rips", ["Netsky"])).toBe(false);
    expect(isOfficialAuthor("Best of Netsky", ["Netsky"])).toBe(false);
  });

  it("REFUSES an unrelated uploader", () => {
    expect(isOfficialAuthor("DnB Uploads 2011", ["Netsky"])).toBe(false);
    expect(isOfficialAuthor("Netsky", [])).toBe(false);
  });

  it("refuses a label or VEVO channel — the documented false-negative bias", () => {
    // Both are genuinely official. Both are refused, deliberately: the id stays internal rather
    // than widening the rule that keeps a rip off the page. Changing this is a ruling.
    expect(isOfficialAuthor("Hospital Records", ["Netsky"])).toBe(false);
    expect(isOfficialAuthor("NetskyVEVO", ["Netsky"])).toBe(false);
  });

  it("refuses an empty or whitespace channel name", () => {
    expect(isOfficialAuthor("", ["Netsky"])).toBe(false);
    expect(isOfficialAuthor("   ", ["Netsky"])).toBe(false);
  });

  it("never lets a credited name that folds away match an empty author", () => {
    // A punctuation-only credit folds to "", and so would a punctuation-only channel; equality on
    // two empty strings would accept anything. Both sides guard for it.
    expect(isOfficialAuthor("!!!", ["???"])).toBe(false);
  });
});

/** A `fetch` stand-in returning one canned oEmbed response. */
function stubFetch(response: { body?: unknown; ok: boolean; throws?: boolean }): typeof fetch {
  return (async () => {
    if (response.throws) {
      throw new Error("network down");
    }

    return {
      json: async () => response.body,
      ok: response.ok,
    };
  }) as unknown as typeof fetch;
}

describe("checkYoutubeOfficial — a verdict only when YouTube actually answered", () => {
  it("rules 1 on an art-track channel", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      ["Netsky"],
      stubFetch({ body: { author_name: "Netsky - Topic" }, ok: true }),
    );

    expect(verdict).toBe(1);
  });

  it("rules 0 on a channel the gate refuses", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      ["Netsky"],
      stubFetch({ body: { author_name: "DnB Uploads 2011" }, ok: true }),
    );

    expect(verdict).toBe(0);
  });

  it("leaves the verdict NULL when the video is gone or private", async () => {
    // A 404/401 says nothing about WHO uploaded it, so it concludes nothing. Storing 0 here would
    // be a guess dressed as a check.
    const verdict = await checkYoutubeOfficial("abc123", ["Netsky"], stubFetch({ ok: false }));

    expect(verdict).toBeNull();
  });

  it("leaves the verdict NULL when the request fails outright", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      ["Netsky"],
      stubFetch({ ok: true, throws: true }),
    );

    expect(verdict).toBeNull();
  });

  it("leaves the verdict NULL when the answer carries no channel name", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      ["Netsky"],
      stubFetch({ body: { title: "a song" }, ok: true }),
    );

    expect(verdict).toBeNull();
  });

  it("never throws, whatever comes back", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      ["Netsky"],
      stubFetch({ body: undefined, ok: true }),
    );

    expect(verdict).toBeNull();
  });
});
