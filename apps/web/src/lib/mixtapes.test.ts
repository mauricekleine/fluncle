import { describe, expect, it } from "vitest";
import { MIXTAPE_COVER_VERSION } from "@fluncle/contracts/util/mixtape-cover";
import { type MixtapeMember, mixtapeCoverUrl, mixtapeDisplayTitle, rowToMixtape } from "./mixtapes";

describe("mixtapeDisplayTitle", () => {
  it("keeps only the part before the first pipe separator", () => {
    expect(mixtapeDisplayTitle("Night Shift | Drum & Bass Mix")).toBe("Night Shift");
    expect(mixtapeDisplayTitle("One | Two | Three")).toBe("One");
  });

  it("leaves a title without the separator untouched", () => {
    expect(mixtapeDisplayTitle("Night Shift")).toBe("Night Shift");
    expect(mixtapeDisplayTitle("A|B")).toBe("A|B");
    expect(mixtapeDisplayTitle("")).toBe("");
  });
});

describe("mixtapeCoverUrl", () => {
  it("builds the versioned cover URL on the public site, square by default", () => {
    expect(mixtapeCoverUrl("019.F.1A")).toBe(
      `https://www.fluncle.com/api/mixtape-cover/019.F.1A?size=square&v=${MIXTAPE_COVER_VERSION}`,
    );
    expect(mixtapeCoverUrl("019.F.1A", "og")).toBe(
      `https://www.fluncle.com/api/mixtape-cover/019.F.1A?size=og&v=${MIXTAPE_COVER_VERSION}`,
    );
  });
});

describe("rowToMixtape", () => {
  it("maps a full row onto the public DTO", () => {
    const dto = rowToMixtape({
      added_at: "2026-06-04T12:00:00.000Z",
      announced_at: "2026-06-05T09:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
      duration_ms: 3_600_000,
      id: "mix-1",
      log_id: "019.F.1A",
      member_count: 24,
      mixcloud_url: "https://www.mixcloud.com/fluncle/one/",
      note: "A late checkpoint, dreamt.",
      published_at: "2026-06-04T12:00:00.000Z",
      recorded_at: "2026-06-03",
      recording_id: "rec-1",
      sequence_number: 1,
      set_video_at: "2026-06-06T00:00:00.000Z",
      soundcloud_url: "https://soundcloud.com/fluncle/one",
      status: "distributing",
      title: "Night Shift | Drum & Bass Mix",
      updated_at: "2026-06-07T00:00:00.000Z",
      youtube_url: "https://www.youtube.com/watch?v=abc",
    });

    expect(dto).toEqual({
      addedAt: "2026-06-04T12:00:00.000Z",
      announcedAt: "2026-06-05T09:00:00.000Z",
      artists: ["Fluncle"],
      coverImageUrl: mixtapeCoverUrl("019.F.1A", "square"),
      createdAt: "2026-06-01T00:00:00.000Z",
      durationMs: 3_600_000,
      externalUrls: {
        mixcloud: "https://www.mixcloud.com/fluncle/one/",
        soundcloud: "https://soundcloud.com/fluncle/one",
        youtube: "https://www.youtube.com/watch?v=abc",
      },
      id: "mix-1",
      logId: "019.F.1A",
      memberCount: 24,
      members: [],
      note: "A late checkpoint, dreamt.",
      publishedAt: "2026-06-04T12:00:00.000Z",
      recordedAt: "2026-06-03",
      recordingId: "rec-1",
      sequenceNumber: 1,
      setVideoAt: "2026-06-06T00:00:00.000Z",
      status: "distributing",
      title: "Night Shift | Drum & Bass Mix",
      type: "mixtape",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
  });

  it("turns every null column into an absent field rather than a null", () => {
    const dto = rowToMixtape({
      added_at: null,
      announced_at: null,
      created_at: null,
      duration_ms: null,
      id: null,
      log_id: null,
      member_count: null,
      mixcloud_url: null,
      note: null,
      published_at: null,
      recorded_at: null,
      recording_id: null,
      sequence_number: null,
      set_video_at: null,
      soundcloud_url: null,
      status: null,
      title: "Unminted",
      updated_at: null,
      youtube_url: null,
    });

    expect(Object.values(dto)).not.toContain(null);
    expect(Object.values(dto.externalUrls)).not.toContain(null);
    expect(dto.coverImageUrl).toBeUndefined();
    expect(dto.logId).toBeUndefined();
    expect(dto.externalUrls).toEqual({
      mixcloud: undefined,
      soundcloud: undefined,
      youtube: undefined,
    });
  });

  it("defaults the status to published when the row carries none", () => {
    expect(rowToMixtape({ title: "Legacy" }).status).toBe("published");
  });

  it("derives no cover until the Log ID is minted", () => {
    expect(rowToMixtape({ log_id: "", title: "Claim" }).coverImageUrl).toBeUndefined();
  });

  it("drops a blank or whitespace-only note", () => {
    expect(rowToMixtape({ note: "", title: "A" }).note).toBeUndefined();
    expect(rowToMixtape({ note: "   \n\t", title: "A" }).note).toBeUndefined();
    expect(rowToMixtape({ note: "  kept  ", title: "A" }).note).toBe("  kept  ");
  });

  it("counts the passed members when the row has no member_count", () => {
    const members = [{ id: "t1" }, { id: "t2" }] as unknown as MixtapeMember[];
    const dto = rowToMixtape({ title: "A" }, members);

    expect(dto.memberCount).toBe(2);
    expect(dto.members).toBe(members);
  });

  it("prefers the row's member_count over the members array, coerced to a number", () => {
    const members = [{ id: "t1" }] as unknown as MixtapeMember[];

    expect(rowToMixtape({ member_count: 30, title: "A" }, members).memberCount).toBe(30);
    expect(rowToMixtape({ member_count: 0, title: "A" }, members).memberCount).toBe(0);
    expect(rowToMixtape({ member_count: "12" as unknown as number, title: "A" }).memberCount).toBe(
      12,
    );
  });
});
