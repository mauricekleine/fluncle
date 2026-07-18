import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { archivePreviewForTrack, buildPreviewArchiveKey } from "./preview-archive";
import { listTracks } from "./tracks";

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

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

  it("builds a stable per-finding key beside the full song, no content hash", () => {
    expect(buildPreviewArchiveKey({ logId: "011.6.8K", mime: "audio/mpeg" })).toBe(
      "011.6.8K/preview.mp3",
    );
    // A changed source MIME lands the preview at a different extension under the
    // same finding folder (the sibling sweep cleans up the previous one on write).
    expect(buildPreviewArchiveKey({ logId: "011.6.8K", mime: "audio/mp4" })).toBe(
      "011.6.8K/preview.m4a",
    );
  });

  it("stores metadata without bumping public updated_at and sweeps stale siblings", async () => {
    const writes: Array<{ args: unknown[]; sql: string }> = [];
    const puts: string[] = [];
    const deletes: string[] = [];
    const bucket = {
      delete: async (key: string) => {
        deletes.push(key);
      },
      put: async (key: string) => {
        puts.push(key);

        return { etag: "etag", httpEtag: '"etag"', key, size: 3 };
      },
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
      key: "011.6.8K/preview.mp3",
      mime: "audio/mpeg",
      source: "deezer:isrc",
    });
    // The preview lands at the stable per-finding key.
    expect(puts).toEqual(["011.6.8K/preview.mp3"]);
    // Every other-extension sibling for this finding is deleted — never the one we
    // just wrote.
    expect(deletes.sort()).toEqual([
      "011.6.8K/preview.aac",
      "011.6.8K/preview.bin",
      "011.6.8K/preview.m4a",
    ]);
    expect(deletes).not.toContain("011.6.8K/preview.mp3");
    expect(writes[0]?.sql).toContain("preview_archive_key");
    expect(writes[0]?.sql).not.toContain("updated_at");
  });

  it("does not sweep siblings when the DB write fails (never orphans the live pointer)", async () => {
    const deletes: string[] = [];
    const bucket = {
      delete: async (key: string) => {
        deletes.push(key);
      },
      put: async (key: string) => ({ etag: "etag", httpEtag: '"etag"', key, size: 3 }),
    };
    const db = {
      execute: async () => {
        throw new Error("db unavailable");
      },
    };

    await expect(
      archivePreviewForTrack(
        {
          bucket: bucket as never,
          bytes: Uint8Array.from([1, 2, 3]).buffer,
          mime: "audio/mp4",
          source: "deezer:isrc",
          track: { logId: "011.6.8K", trackId: "spotify-track" },
        },
        db as never,
      ),
    ).rejects.toThrow("db unavailable");

    // The sweep runs LAST, after the DB commit — a failed DB write must not delete any
    // sibling, so the row keeps pointing at an object that still exists.
    expect(deletes).toEqual([]);
  });

  // THE RAIL, ENFORCED. The slot holds ONE official 30s preview, never a full song
  // (audio-source policy: captured full audio is internal-only, in the private source-audio
  // bucket). analyze-track's `--archive-dir` used to be source-blind, so running it with
  // `--audio-file` emitted the WHOLE captured song as `preview.<ext>` — and the skill told
  // you to upload exactly that. The analyzer now refuses, and the server refuses too: a body
  // an order of magnitude past any 30s clip is not a preview, whatever the caller claims.
  it("rejects a full song — a body too large to be a 30s preview never reaches R2", async () => {
    const puts: string[] = [];
    const bucket = {
      delete: async () => undefined,
      put: async (key: string) => {
        puts.push(key);
      },
    };
    const db = { execute: async () => ({ rows: [] }) };

    // ~6MB — a real song. A 30s preview at a generous 320kbps is ~1.2MB.
    const fullSong = new Uint8Array(6_000_000).buffer;

    await expect(
      archivePreviewForTrack(
        {
          bucket: bucket as never,
          bytes: fullSong,
          mime: "audio/mp4",
          source: "audio-file",
          track: { logId: "011.6.8K", trackId: "spotify-track" },
        },
        db as never,
      ),
    ).rejects.toThrow(/preview/i);

    // Nothing was written: the rail rejects BEFORE the put, so no full song lands in R2
    // wearing a preview's name.
    expect(puts).toEqual([]);
  });

  it("never targets the public fluncle-videos bucket / VIDEOS binding", async () => {
    // fluncle-videos is world-served at found.fluncle.com; the 30s preview archive
    // must land in the PRIVATE fluncle-source-audio bucket. This mirrors the box
    // sweep scripts' "never fluncle-videos" guard (docs/agents/hermes/scripts/*).
    const route = await source("../../routes/api/admin/tracks.$trackId.preview.ts");

    // Assert the call exists first so the guard can't silently degrade if the handler
    // is renamed/moved (indexOf(-1) + slice would otherwise make the checks vacuous).
    expect(route).toContain("archivePreviewForTrack({");

    const archiveCall = route.slice(route.indexOf("archivePreviewForTrack({"));

    expect(archiveCall).toContain("bucket: env.SOURCE_AUDIO");
    expect(archiveCall).not.toContain("env.VIDEOS");
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
            video_palette: null,
            video_register: null,
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
