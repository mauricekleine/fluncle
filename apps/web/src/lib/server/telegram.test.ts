import { describe, expect, it } from "vitest";
import { formatMixtapeAnnouncement } from "./telegram";

const BASE = {
  externalUrls: {
    mixcloud: "https://www.mixcloud.com/fluncle/a-set/",
    youtube: "https://youtu.be/vid-1",
  },
  logId: "019.F.3A",
  note: "Three sectors deep and it all held together.",
  title: "Fluncle Drum & Bass Mixtape #3 | 019.F.3A",
};

describe("formatMixtapeAnnouncement", () => {
  it("leads with the authored dream note, turns to the crew, then links + the /log home", () => {
    expect(formatMixtapeAnnouncement(BASE)).toBe(
      [
        "🛸 Fresh mixtape",
        "",
        "Three sectors deep and it all held together.",
        "Pull it up loud, cosmonauts.",
        "",
        "Fluncle Drum & Bass Mixtape #3 · fluncle://019.F.3A",
        "",
        "🎧 YouTube: https://youtu.be/vid-1",
        "🎧 Mixcloud: https://www.mixcloud.com/fluncle/a-set/",
        "Read the log: https://www.fluncle.com/log/019.F.3A",
      ].join("\n"),
    );
  });

  it("falls back to the default dream/checkpoint line when there's no note", () => {
    const text = formatMixtapeAnnouncement({ ...BASE, note: null });

    expect(text).toContain("checkpoint before the next sector");

    expect(text).toContain("one long mixtape");

    expect(text).toContain("Pull it up loud, cosmonauts.");

    expect(text).not.toContain("!");
  });

  it("treats a blank/whitespace note as absent (uses the default line)", () => {
    const text = formatMixtapeAnnouncement({ ...BASE, note: "   " });

    expect(text).toContain("checkpoint before the next sector");
  });

  it("strips the ` | <coordinate>` title suffix and shows the coordinate once", () => {
    const text = formatMixtapeAnnouncement(BASE);

    expect(text).toContain("Fluncle Drum & Bass Mixtape #3 · fluncle://019.F.3A");

    expect(text).not.toContain("Mixtape #3 | 019.F.3A");
  });

  it("includes SoundCloud when present and omits any platform that's absent", () => {
    const text = formatMixtapeAnnouncement({
      ...BASE,
      externalUrls: {
        soundcloud: "https://soundcloud.com/fluncle/a-set",
        youtube: "https://youtu.be/vid-1",
      },
    });

    expect(text).toContain("🎧 YouTube: https://youtu.be/vid-1");
    expect(text).toContain("🎧 SoundCloud: https://soundcloud.com/fluncle/a-set");
    expect(text).not.toContain("Mixcloud");
  });
});

describe("formatTelegramMessage — the Spotify line is conditional on a presence", () => {
  const track = {
    artists: ["Artificial Intelligence"],
    durationMs: 270_000,
    spotifyArtistIds: [],
    spotifyUri: "",
    spotifyUrl: "",
    title: "Ask Yourself",
    trackId: "t1",
  };

  it("omits the Spotify line when there is no URL, and still links the log page", async () => {
    const { formatTelegramMessage } = await import("./telegram");
    const message = formatTelegramMessage(track, undefined, "044.1.3L");

    expect(message).not.toContain("Spotify:");
    expect(message).toContain("Ask Yourself");
    expect(message).toContain("/log/044.1.3L");
  });

  it("keeps the Spotify line when the URL exists (the add path, unchanged)", async () => {
    const { formatTelegramMessage } = await import("./telegram");
    const message = formatTelegramMessage(
      { ...track, spotifyUrl: "https://open.spotify.com/track/x" },
      undefined,
      "044.1.3L",
    );

    expect(message).toContain("🎧 Spotify: https://open.spotify.com/track/x");
    expect(message).toContain("/log/044.1.3L");
  });
});
