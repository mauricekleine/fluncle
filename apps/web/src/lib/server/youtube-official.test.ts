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
    expect(isOfficialAuthor("Some Artist - Topic", { artists: [] })).toBe(true);
    expect(isOfficialAuthor("Netsky - Topic", { artists: ["Someone Else"] })).toBe(true);
  });

  it("accepts the artist's own channel on folded equality", () => {
    expect(isOfficialAuthor("Netsky", { artists: ["Netsky"] })).toBe(true);
    expect(isOfficialAuthor("netsky", { artists: ["Netsky"] })).toBe(true);
    // The house fold meets `&` with `and`, and strips accents.
    expect(isOfficialAuthor("Chase and Status", { artists: ["Chase & Status"] })).toBe(true);
    expect(isOfficialAuthor("Noisia", { artists: ["Noïsia"] })).toBe(true);
  });

  it("accepts when any one credited artist matches", () => {
    expect(isOfficialAuthor("Halogenix", { artists: ["Alix Perez", "Halogenix"] })).toBe(true);
  });

  it("REFUSES a channel that merely embeds an artist's name", () => {
    // The whole reason this is equality and not containment: a rip channel names the artist too.
    expect(isOfficialAuthor("Netsky Fan Rips", { artists: ["Netsky"] })).toBe(false);
    expect(isOfficialAuthor("Best of Netsky", { artists: ["Netsky"] })).toBe(false);
  });

  it("REFUSES an unrelated uploader", () => {
    expect(isOfficialAuthor("DnB Uploads 2011", { artists: ["Netsky"] })).toBe(false);
    expect(isOfficialAuthor("Netsky", { artists: [] })).toBe(false);
  });

  it("refuses a VEVO channel — the documented false-negative bias", () => {
    // Genuinely official, and still refused: the id stays internal rather than widening the rule
    // that keeps a rip off the page. Changing this is a ruling, and the label class below IS one.
    expect(isOfficialAuthor("NetskyVEVO", { artists: ["Netsky"] })).toBe(false);
  });

  it("refuses an empty or whitespace channel name", () => {
    expect(isOfficialAuthor("", { artists: ["Netsky"] })).toBe(false);
    expect(isOfficialAuthor("   ", { artists: ["Netsky"] })).toBe(false);
  });

  it("never lets a credited name that folds away match an empty author", () => {
    // A punctuation-only credit folds to "", and so would a punctuation-only channel; equality on
    // two empty strings would accept anything. Both sides guard for it.
    expect(isOfficialAuthor("!!!", { artists: ["???"] })).toBe(false);
  });
});

describe("isOfficialAuthor — the recording's own label channel (the 2026-07-31 widening)", () => {
  it("accepts the label that released THIS recording", () => {
    // The live case the widening was ruled on: `RFObrLVHMvg`, uploaded by "Fokuz Recordings", is
    // the label's own upload of a Fokuz release. Rule 2 alone refused it, which was never right.
    expect(
      isOfficialAuthor("Fokuz Recordings", {
        artists: ["Lauren Ritchie"],
        labels: ["Fokuz Recordings"],
      }),
    ).toBe(true);
  });

  it("accepts on EITHER label spelling — the canonical name or the raw release string", () => {
    // `labels` carries both: `labels.name` (the collapsed entity) and the raw `tracks.label`. A
    // crawled row can have only the second one, and a channel matching it is still that label's.
    expect(isOfficialAuthor("Fokuz Recordings", { artists: ["Anile"], labels: ["Fokuz"] })).toBe(
      false,
    );
    expect(
      isOfficialAuthor("Fokuz", { artists: ["Anile"], labels: ["Fokuz Recordings", "Fokuz"] }),
    ).toBe(true);
  });

  it("REFUSES a label channel on a track that label did not release", () => {
    // The narrowness is the whole safety property: a label channel is permission for that label's
    // own releases and for nothing else. Hospital's channel over a Fokuz release is a re-upload.
    expect(
      isOfficialAuthor("Hospital Records", {
        artists: ["Lauren Ritchie"],
        labels: ["Fokuz Recordings"],
      }),
    ).toBe(false);
    // And on a track with no label at all it has nothing to be equal to.
    expect(isOfficialAuthor("Hospital Records", { artists: ["Netsky"] })).toBe(false);
    expect(isOfficialAuthor("Hospital Records", { artists: ["Netsky"], labels: [] })).toBe(false);
  });

  it("accepts Hospital's own channel on a Hospital release, on the same equality", () => {
    // Not a special case and not an allowlist — the same clause, met by a row that actually is one
    // of theirs. This is the pair that shows the rule is scoped to the ROW, not to the channel.
    expect(
      isOfficialAuthor("Hospital Records", { artists: ["Netsky"], labels: ["Hospital Records"] }),
    ).toBe(true);
  });

  it("stays EQUALITY, never containment, on the label side too", () => {
    expect(
      isOfficialAuthor("Hospital Records Rips", {
        artists: ["Netsky"],
        labels: ["Hospital Records"],
      }),
    ).toBe(false);
    expect(
      isOfficialAuthor("Best of Hospital Records", {
        artists: ["Netsky"],
        labels: ["Hospital Records"],
      }),
    ).toBe(false);
  });

  it("does NOT strip label boilerplate the way the capture sweep's ranker does", () => {
    // The ranker normalizes "Hospital Records" → "hospital" because it is CHOOSING between
    // candidates and can afford to be generous. This is GRANTING PERMISSION and cannot: "Critical"
    // and "Critical Music" are not provably the same party, so the shorter channel is refused.
    expect(isOfficialAuthor("Critical", { artists: ["Enei"], labels: ["Critical Music"] })).toBe(
      false,
    );
  });

  it("meets the house fold on the label side — `&` and accents included", () => {
    expect(
      isOfficialAuthor("Drum and Bass Arena", {
        artists: ["Calibre"],
        labels: ["Drum & Bass Arena"],
      }),
    ).toBe(true);
  });

  it("never lets a label that folds away match an empty author", () => {
    expect(isOfficialAuthor("!!!", { artists: [], labels: ["???"] })).toBe(false);
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
      { artists: ["Netsky"] },
      stubFetch({ body: { author_name: "Netsky - Topic" }, ok: true }),
    );

    expect(verdict).toBe(1);
  });

  it("rules 1 on the recording's own label channel", async () => {
    // The Fokuz case, end to end through the transport: the oEmbed answer names the label, the
    // widened predicate accepts it, and the verdict that reaches the column is 1.
    const verdict = await checkYoutubeOfficial(
      "RFObrLVHMvg",
      { artists: ["Lauren Ritchie"], labels: ["Fokuz Recordings"] },
      stubFetch({ body: { author_name: "Fokuz Recordings" }, ok: true }),
    );

    expect(verdict).toBe(1);
  });

  it("rules 0 on a label channel that is not this recording's label", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      { artists: ["Lauren Ritchie"], labels: ["Fokuz Recordings"] },
      stubFetch({ body: { author_name: "Hospital Records" }, ok: true }),
    );

    expect(verdict).toBe(0);
  });

  it("rules 0 on a channel the gate refuses", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      { artists: ["Netsky"] },
      stubFetch({ body: { author_name: "DnB Uploads 2011" }, ok: true }),
    );

    expect(verdict).toBe(0);
  });

  it("leaves the verdict NULL when the video is gone or private", async () => {
    // A 404/401 says nothing about WHO uploaded it, so it concludes nothing. Storing 0 here would
    // be a guess dressed as a check.
    const verdict = await checkYoutubeOfficial(
      "abc123",
      { artists: ["Netsky"] },
      stubFetch({ ok: false }),
    );

    expect(verdict).toBeNull();
  });

  it("leaves the verdict NULL when the request fails outright", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      { artists: ["Netsky"] },
      stubFetch({ ok: true, throws: true }),
    );

    expect(verdict).toBeNull();
  });

  it("leaves the verdict NULL when the answer carries no channel name", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      { artists: ["Netsky"] },
      stubFetch({ body: { title: "a song" }, ok: true }),
    );

    expect(verdict).toBeNull();
  });

  it("never throws, whatever comes back", async () => {
    const verdict = await checkYoutubeOfficial(
      "abc123",
      { artists: ["Netsky"] },
      stubFetch({ body: undefined, ok: true }),
    );

    expect(verdict).toBeNull();
  });
});
