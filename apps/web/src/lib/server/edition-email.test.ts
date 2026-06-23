import { type EditionDTO, type TrackListItem } from "@fluncle/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The render hydrates each finding's tiny `{ logId, why }` reference to its live
// `Artist — Title` (+ Spotify link) via `getTracksByLogIds` — mocked here so the
// render is proved without a real libsql instance.

const getTracksByLogIds = vi.hoisted(() => vi.fn());

vi.mock("./tracks", () => ({ getTracksByLogIds }));

const { renderEditionEmailHtml } = await import("./edition-email");

function track(overrides: Partial<TrackListItem> = {}): TrackListItem {
  return {
    addedAt: "2026-06-20T00:00:00.000Z",
    addedToSpotify: true,
    artists: ["Photek"],
    durationMs: 300_000,
    enrichmentStatus: "done",
    postedToTelegram: true,
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Ni Ten Ichi Ryu",
    trackId: "abc",
    ...overrides,
  };
}

function edition(content: EditionDTO["content"]): EditionDTO {
  return { content, id: "edition-id", status: "draft" };
}

describe("renderEditionEmailHtml — finding hydration", () => {
  beforeEach(() => {
    getTracksByLogIds.mockReset();
  });

  it("renders Artist — Title (not the bare logId) linked to its log page + a Spotify link", async () => {
    getTracksByLogIds.mockResolvedValue({ "021.7.1A": track() });

    const html = await renderEditionEmailHtml(
      edition({
        galaxies: [{ findings: [{ logId: "021.7.1A", why: "the snare alone" }], galaxy: "Astral" }],
      }),
    );

    expect(html).toContain("Photek — Ni Ten Ichi Ryu");
    expect(html).not.toContain(">021.7.1A<");
    expect(html).toContain('href="https://www.fluncle.com/log/021.7.1A"');
    expect(html).toContain('href="https://open.spotify.com/track/abc"');
    expect(html).toContain("the snare alone");
    expect(html).toContain("<h2>Astral</h2>");
  });

  it("batches all referenced logIds into ONE read (no N+1)", async () => {
    getTracksByLogIds.mockResolvedValue({});

    await renderEditionEmailHtml(
      edition({
        galaxies: [
          {
            findings: [{ logId: "021.7.1A" }, { logId: "022.7.1A" }],
            galaxy: "Solar",
          },
          { findings: [{ logId: "023.7.1A" }], galaxy: "Nebular" },
        ],
        mixtapeRef: "019.F.1A",
      }),
    );

    expect(getTracksByLogIds).toHaveBeenCalledTimes(1);
    expect(getTracksByLogIds).toHaveBeenCalledWith([
      "021.7.1A",
      "022.7.1A",
      "023.7.1A",
      "019.F.1A",
    ]);
  });

  it("falls back to the bare logId (still linked) when no live finding hydrates", async () => {
    getTracksByLogIds.mockResolvedValue({});

    const html = await renderEditionEmailHtml(
      edition({ galaxies: [{ findings: [{ logId: "099.7.1A" }], galaxy: "Lunar" }] }),
    );

    expect(html).toContain(">099.7.1A<");
    expect(html).toContain('href="https://www.fluncle.com/log/099.7.1A"');
  });

  it("hydrates the mixtape ref to its title", async () => {
    getTracksByLogIds.mockResolvedValue({
      "019.F.1A": track({ artists: ["Fluncle"], logId: "019.F.1A", title: "Mixtape #3" }),
    });

    const html = await renderEditionEmailHtml(edition({ mixtapeRef: "019.F.1A" }));

    expect(html).toContain("Fluncle — Mixtape #3");
    expect(html).toContain('href="https://www.fluncle.com/log/019.F.1A"');
  });
});
