import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE APPLE CATALOGUE DRAIN + ALBUM FACTS, PROVEN against the REAL schema (RFC musickit U1).
//
// The catalogue sweep reads a worklist off `tracks` (an anti-join onto the certification) and the
// facts writer joins `tracks → albums` — both in SQL, so only a real engine proves them. The Apple
// oracle and the breaker are mocked (no network, no durable breaker state): what is on trial is
// the worklist, the catalogue-aware URL write (no findings lastmod), and the once-per-album facts.

let db: Client;

const appleCatalogLookupByIsrc = vi.fn();
const appleCatalogLookupByIsrcs = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});
vi.mock("./apple-music", () => ({
  appleCatalogLookupByIsrc: (...a: unknown[]) => appleCatalogLookupByIsrc(...a),
  appleCatalogLookupByIsrcs: (...a: unknown[]) => appleCatalogLookupByIsrcs(...a),
}));
// The breaker is proven in apple-breaker.test.ts; here it is open + a no-op so the drain runs.
vi.mock("./apple-breaker", () => ({
  areAppleCallsAllowed: async () => true,
  isAppleCallBudgetAvailable: async () => true,
  recordAppleAuthOutcome: async () => {},
  recordAppleCall: async () => {},
}));

/** Stamp a track's ISRC + optional album pointer. */
async function withIsrc(trackId: string, isrc: string, albumId?: string): Promise<void> {
  await db.execute({
    args: [isrc, albumId ?? null, trackId],
    sql: `update tracks set isrc = ?, album_id = ? where track_id = ?`,
  });
}

/** Insert an `albums` row (the facts target). */
async function seedAlbum(id: string, slug: string): Promise<void> {
  const at = "2026-07-01T00:00:00.000Z";

  await db.execute({
    args: [id, `Album ${slug}`, slug, at, at],
    sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

/** Read one album row (facts inclusive). */
async function readAlbum(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({ args: [id], sql: `select * from albums where id = ?` });

  return result.rows[0] as Record<string, unknown> | undefined;
}

/** Read one track row. */
async function readTrack(trackId: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({
    args: [trackId],
    sql: `select * from tracks where track_id = ?`,
  });

  return result.rows[0] as Record<string, unknown> | undefined;
}

/** A batched-oracle result mapping the given ISRC → a bare URL bundle. */
function batchedUrl(isrc: string, url: string) {
  return {
    bundles: new Map([[isrc, { songId: `s-${isrc}`, songUrl: url }]]),
    configured: true,
    ok: true,
  };
}

/** A single-ISRC oracle result carrying a canonical album's facts. */
function singleWithAlbum(url: string) {
  return {
    bundle: {
      canonicalAlbum: {
        artwork: {
          bgColor: "000000",
          height: 3000,
          textColor1: "ffffff",
          textColor2: "eeeeee",
          textColor3: "dddddd",
          textColor4: "cccccc",
          urlTemplate: "https://is1.mzstatic.com/image/{w}x{h}bb.jpg",
          width: 3000,
        },
        id: "apple-album-1",
        recordLabel: "Real Imprint",
        upc: "00602445123456",
      },
      songId: "s1",
      songUrl: url,
    },
    configured: true,
    ok: true,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  vi.clearAllMocks();
});

describe("backfillAppleMusicCatalogue — the catalogue drain", () => {
  it("resolves a catalogue track's URL (no findings row to bump), records done on tracks", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000001" });
    await withIsrc("cat00000000000000000001", "ISRC001");
    appleCatalogLookupByIsrcs.mockResolvedValueOnce(
      batchedUrl("ISRC001", "https://music.apple.com/us/album/x/1?i=2"),
    );

    const { backfillAppleMusicCatalogue } = await import("./backfill");
    const result = await backfillAppleMusicCatalogue(50, false);

    expect(result.resolvedCount).toBe(1);
    expect(result.resolved).toEqual([
      { trackId: "cat00000000000000000001", url: "https://music.apple.com/us/album/x/1?i=2" },
    ]);
    const track = await readTrack("cat00000000000000000001");
    expect(track?.apple_music_url).toBe("https://music.apple.com/us/album/x/1?i=2");
    expect(track?.backfill_apple_music_done_at).toBeTruthy();
    // No single-ISRC call: the row has no album_id, so there is nothing to fact-stamp.
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
  });

  it("writes album facts ONCE off the single-ISRC oracle, then is idempotent", async () => {
    await seedAlbum("alb1", "album-one");
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000002" });
    await withIsrc("cat00000000000000000002", "ISRC002", "alb1");

    appleCatalogLookupByIsrcs.mockResolvedValue(
      batchedUrl("ISRC002", "https://music.apple.com/us/album/x/2?i=3"),
    );
    appleCatalogLookupByIsrc.mockResolvedValue(
      singleWithAlbum("https://music.apple.com/us/album/x/2?i=3"),
    );

    const { backfillAppleMusicCatalogue } = await import("./backfill");
    const first = await backfillAppleMusicCatalogue(50, false);

    expect(first.albumFactsWritten).toBe(1);
    const album = await readAlbum("alb1");
    expect(album?.apple_album_id).toBe("apple-album-1");
    expect(album?.record_label_raw).toBe("Real Imprint");
    expect(album?.upc).toBe("00602445123456");
    expect(album?.artwork_url_template).toBe("https://is1.mzstatic.com/image/{w}x{h}bb.jpg");
    expect(Number(album?.artwork_width)).toBe(3000);
    expect(album?.artwork_bg_color).toBe("000000");
    expect(album?.artwork_text_color4).toBe("cccccc");

    // Second pass: the track now carries a URL (excluded from the worklist) and the album is
    // stamped — nothing to do.
    const second = await backfillAppleMusicCatalogue(50, false);
    expect(second.resolvedCount).toBe(0);
    expect(second.albumFactsWritten).toBe(0);
  });

  it("a clean no-match records TRIED (attempted, not done), leaves the URL null", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000003" });
    await withIsrc("cat00000000000000000003", "ISRC003");
    // Apple has no song for this ISRC — the batched map is empty.
    appleCatalogLookupByIsrcs.mockResolvedValueOnce({
      bundles: new Map(),
      configured: true,
      ok: true,
    });

    const { backfillAppleMusicCatalogue } = await import("./backfill");
    const result = await backfillAppleMusicCatalogue(50, false);

    expect(result.unresolved).toEqual(["cat00000000000000000003"]);
    const track = await readTrack("cat00000000000000000003");
    expect(track?.apple_music_url).toBeNull();
    expect(track?.backfill_apple_music_attempted_at).toBeTruthy();
    expect(track?.backfill_apple_music_done_at).toBeNull();
  });

  it("excludes a CERTIFIED finding (the catalogue anti-join) — no oracle call", async () => {
    await seedTrack(db, {
      addedToSpotify: true,
      logId: "LOG-CERT",
      postedToTelegram: true,
      trackId: "finding0000000000000001",
    });
    await withIsrc("finding0000000000000001", "ISRCCERT");

    const { backfillAppleMusicCatalogue } = await import("./backfill");
    const result = await backfillAppleMusicCatalogue(50, false);

    expect(result.resolvedCount).toBe(0);
    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
  });

  it("skips a row already marked done (reliability gate) — no oracle call", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000004" });
    await withIsrc("cat00000000000000000004", "ISRC004");
    await db.execute({
      args: ["2026-01-01T00:00:00.000Z", "cat00000000000000000004"],
      sql: `update tracks set backfill_apple_music_done_at = ? where track_id = ?`,
    });

    const { backfillAppleMusicCatalogue } = await import("./backfill");
    const result = await backfillAppleMusicCatalogue(50, false);

    expect(result.resolvedCount).toBe(0);
    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
  });

  it("dry-run previews the eligible set without a call or a write", async () => {
    await seedCatalogueTrack(db, { trackId: "cat00000000000000000005" });
    await withIsrc("cat00000000000000000005", "ISRC005");

    const { backfillAppleMusicCatalogue } = await import("./backfill");
    const result = await backfillAppleMusicCatalogue(50, true);

    expect(result.dryRun).toBe(true);
    expect(result.unresolved).toEqual(["cat00000000000000000005"]);
    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
    expect((await readTrack("cat00000000000000000005"))?.apple_music_url).toBeNull();
  });
});

describe("backfillAppleMusicUrls — the findings sweep also writes album facts", () => {
  it("resolves a finding's URL (bumping its lastmod) AND stamps its album's facts", async () => {
    await seedAlbum("alb2", "album-two");
    await seedTrack(db, {
      addedToSpotify: true,
      logId: "LOG-FACT",
      postedToTelegram: true,
      trackId: "finding0000000000000002",
    });
    await withIsrc("finding0000000000000002", "ISRCFACT", "alb2");

    appleCatalogLookupByIsrc.mockResolvedValue(
      singleWithAlbum("https://music.apple.com/us/album/y/9?i=8"),
    );

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.resolvedCount).toBe(1);
    expect(result.albumFactsWritten).toBe(1);

    const track = await readTrack("finding0000000000000002");
    expect(track?.apple_music_url).toBe("https://music.apple.com/us/album/y/9?i=8");
    // The finding's public lastmod moved (bumpFinding = true) — the sameAs advertised on /log.
    const finding = await db.execute({
      args: ["finding0000000000000002"],
      sql: `select updated_at from findings where track_id = ?`,
    });
    expect(finding.rows[0]?.updated_at).toBeTruthy();

    const album = await readAlbum("alb2");
    expect(album?.apple_album_id).toBe("apple-album-1");
    expect(album?.record_label_raw).toBe("Real Imprint");
  });
});
