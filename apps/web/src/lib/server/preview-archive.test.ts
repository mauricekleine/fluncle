import { beforeEach, describe, expect, it, vi } from "vitest";
import { archivePreviewForTrack, buildPreviewArchiveKey } from "./preview-archive";
import { listTracks } from "./tracks";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

describe("preview archive helpers", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("builds a less obvious Log-ID-based operator-only archive path", async () => {
    const key = await buildPreviewArchiveKey({
      bytes: Uint8Array.from([1, 2, 3]).buffer,
      logId: "011.6.8K",
      mime: "audio/mpeg",
    });

    expect(key).toMatch(/^analysis\/previews\/011\.6\.8K\/[a-f0-9]{64}\.mp3$/);
  });

  it("stores metadata without bumping public updated_at", async () => {
    const writes: Array<{ args: unknown[]; sql: string }> = [];
    const bucket = {
      put: async () => ({ etag: "etag", httpEtag: '"etag"', key: "key", size: 3 }),
    };
    const db = {
      execute: async (query: { args: unknown[]; sql: string }) => {
        writes.push(query);

        return { rows: [] };
      },
    };

    const archive = await archivePreviewForTrack(
      {
        bucket: bucket as never,
        bytes: Uint8Array.from([1, 2, 3]).buffer,
        mime: "audio/mpeg",
        now: new Date("2026-06-11T10:00:00.000Z"),
        source: "deezer:isrc",
        track: { logId: "011.6.8K", trackId: "spotify-track" },
      },
      db as never,
    );

    expect(archive).toMatchObject({
      archivedAt: "2026-06-11T10:00:00.000Z",
      mime: "audio/mpeg",
      source: "deezer:isrc",
    });
    expect(writes[0]?.sql).toContain("preview_archive_key");
    expect(writes[0]?.sql).not.toContain("updated_at");
  });

  it("rejects archive uploads for tracks without a Log ID", async () => {
    await expect(
      archivePreviewForTrack(
        {
          bucket: { put: async () => ({}) } as never,
          bytes: Uint8Array.from([1]).buffer,
          mime: "audio/mpeg",
          source: "deezer:isrc",
          track: { trackId: "spotify-track" },
        },
        { execute: async () => ({ rows: [] }) } as never,
      ),
    ).rejects.toMatchObject({ code: "no_log_id", status: 400 });
  });

  it("keeps operator-only archive fields out of public track DTOs", async () => {
    execute.mockImplementation(async (query: { sql: string }) => {
      if (query.sql.includes("count(*)")) {
        return { rows: [{ total_count: 1 }] };
      }

      return {
        rows: [
          {
            added_at: "2026-06-11T10:00:00.000Z",
            added_to_spotify: 1,
            album: "Album",
            album_image_url: "https://example.com/cover.jpg",
            artists_json: JSON.stringify(["Artist"]),
            bpm: 174,
            duration_ms: 180000,
            enrichment_status: "done",
            isrc: "ISRC123",
            key: "A minor",
            label: "Label",
            log_id: "011.6.8K",
            note: null,
            popularity: 42,
            posted_to_telegram: 1,
            preview_archive_key: "analysis/previews/011.6.8K/hash.mp3",
            preview_archive_mime: "audio/mpeg",
            preview_archive_source: "deezer:isrc",
            preview_archived_at: "2026-06-11T10:01:00.000Z",
            preview_url: "https://cdns-preview.dzcdn.net/live.mp3",
            release_date: "2026-06-01",
            spotify_url: "https://open.spotify.com/track/spotify-track",
            tags_json: JSON.stringify(["liquid"]),
            tags_source: "auto",
            tiktok_url: null,
            title: "Track",
            track_id: "spotify-track",
            updated_at: null,
            video_grain: null,
            video_url: null,
            video_vehicle: null,
          },
        ],
      };
    });

    const page = await listTracks({ limit: 1 });
    const publicJson = JSON.stringify(page.tracks[0]);

    expect(publicJson).toContain("previewUrl");
    expect(publicJson).not.toContain("preview_archive");
    expect(publicJson).not.toContain("previewArchive");
  });

  it("keeps dropped mixtape cover columns out of the public feed query", async () => {
    const queries: string[] = [];
    execute.mockImplementation(async (query: { sql: string }) => {
      queries.push(query.sql);

      if (query.sql.includes("from mixtapes m")) {
        return {
          rows: [
            {
              added_at: "2026-06-19T10:00:00.000Z",
              duration_ms: 3_480_000,
              id: "mixtape-id",
              log_id: "020.F.1A",
              member_count: 12,
              mixcloud_url: "https://mixcloud.com/fluncle/test",
              note: "A checkpoint.",
              sequence_number: 1,
              soundcloud_url: null,
              title: "Fluncle Drum & Bass Mixtape #1 | 020.F.1A",
              updated_at: null,
              youtube_url: null,
            },
          ],
        };
      }

      if (query.sql.includes("count(*)")) {
        return { rows: [{ total_count: 0 }] };
      }

      return { rows: [] };
    });

    const page = await listTracks({ includeMixtapes: true, limit: 1 });
    const mixtape = page.tracks[0];

    expect(queries.join("\n")).not.toContain("cover_image_url");
    expect(mixtape?.type).toBe("mixtape");
    if (mixtape?.type !== "mixtape") {
      throw new Error("expected a mixtape feed item");
    }
    expect(mixtape.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square&v=2",
    );
  });
});
