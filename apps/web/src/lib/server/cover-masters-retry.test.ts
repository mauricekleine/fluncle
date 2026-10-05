import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

import { resolveCoverMasters } from "./cover-masters";
import { createIntegrationDb, seedTrack } from "./integration-db";

let db: Client;

const executeCalls: Array<{ argc: number; sql: string }> = [];

const APPLE_TEMPLATE = "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg";

function pngBytes(w: number, h: number): ArrayBuffer {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, w);
  view.setUint32(20, h);

  return buf;
}

function fakeBucket() {
  const put = vi.fn(
    (_key: string, _value: ArrayBuffer | string, _options?: unknown): Promise<undefined> =>
      Promise.resolve(undefined),
  );

  return { bucket: { put } as unknown as Pick<R2Bucket, "put">, put };
}

function stubImageFetch(png = pngBytes(1200, 1200)) {
  const fetchMock = vi.fn(
    async (_url: string) =>
      new Response(png, { headers: { "content-type": "image/png" }, status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

type SeedAlbum = {
  attemptedAt?: null | string;
  failures?: number;
  imageKey?: null | string;
  slug: string;
  state?: "none" | "pending" | "resolved";
  withAppleSource?: boolean;
};

async function seedAlbum(album: SeedAlbum): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [
      `alb_${album.slug}`,
      album.slug,
      album.slug,
      album.state ?? "pending",
      album.failures ?? 0,
      album.attemptedAt ?? null,
      album.imageKey ?? null,
      album.withAppleSource ? APPLE_TEMPLATE : null,
      album.withAppleSource ? 3000 : null,
      album.withAppleSource ? 3000 : null,
      now,
      now,
    ],
    sql: `insert into albums
            (id, name, slug, image_state, image_failures, image_attempted_at, image_key,
             artwork_url_template, artwork_width, artwork_height, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function seedArtist(artist: {
  imageUrl?: null | string;
  slug: string;
  state?: "none" | "pending" | "resolved";
}): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [
      `art_${artist.slug}`,
      artist.slug,
      artist.slug,
      artist.state ?? "pending",
      artist.imageUrl ?? null,
      now,
      now,
    ],
    sql: `insert into artists
            (id, name, slug, image_state, image_url, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function albumRow(slug: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({ args: [slug], sql: `select * from albums where slug = ?` });

  return result.rows[0] as Record<string, unknown> | undefined;
}

async function artistRow(slug: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({ args: [slug], sql: `select * from artists where slug = ?` });

  return result.rows[0] as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();

  executeCalls.length = 0;
  const original = db.execute.bind(db);
  db.execute = ((stmt: unknown) => {
    if (stmt && typeof stmt === "object" && "sql" in stmt) {
      const detailed = stmt as { args?: unknown[]; sql: string };
      executeCalls.push({
        argc: Array.isArray(detailed.args) ? detailed.args.length : 0,
        sql: detailed.sql,
      });
    }

    return original(stmt as Parameters<Client["execute"]>[0]);
  }) as Client["execute"];

  holder.db = db;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveCoverMasters — retry=none re-queues terminal none rows", () => {
  it("dry run re-queues ONLY the kind's terminal none rows and writes nothing", async () => {
    await seedAlbum({ slug: "none-1", state: "none", withAppleSource: true });
    await seedAlbum({ slug: "none-2", state: "none", withAppleSource: true });
    await seedAlbum({ imageKey: "albums/resolved-1.jpg", slug: "resolved-1", state: "resolved" });
    await seedAlbum({ slug: "pending-1", state: "pending" });
    await seedArtist({ imageUrl: "https://i.scdn.co/image/x", slug: "artist-none", state: "none" });

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, true, undefined, true);

    expect(result.requeued).toEqual(["none-1", "none-2"]);
    expect(result.requeuedCount).toBe(2);
    expect(result.dryRun).toBe(true);

    expect(put).not.toHaveBeenCalled();
    expect((await albumRow("none-1"))?.image_state).toBe("none");
    expect((await albumRow("none-2"))?.image_state).toBe("none");
    expect((await albumRow("resolved-1"))?.image_state).toBe("resolved");
    expect((await albumRow("resolved-1"))?.image_key).toBe("albums/resolved-1.jpg");
    expect((await albumRow("pending-1"))?.image_state).toBe("pending");

    expect((await artistRow("artist-none"))?.image_state).toBe("none");
  });

  it("wet retry resolves its selected rows and leaves ordinary pending work untouched", async () => {
    await seedAlbum({ slug: "a-pending", state: "pending", withAppleSource: true });
    await seedAlbum({
      attemptedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      failures: 5,
      slug: "z-none",
      state: "none",
      withAppleSource: true,
    });
    stubImageFetch();

    const { bucket } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 1, false, undefined, true);

    expect(result.requeued).toEqual(["z-none"]);

    expect(result.resolved).toEqual(["z-none"]);
    expect((await albumRow("a-pending"))?.image_state).toBe("pending");

    const requeued = await albumRow("z-none");
    expect(requeued?.image_state).toBe("resolved");
    expect(Number(requeued?.image_failures)).toBe(0);
    expect(requeued?.image_attempted_at).toEqual(expect.any(String));
  });

  it("the SAME call then re-walks the ladder and mints a master for a re-queued row", async () => {
    await seedAlbum({ failures: 5, slug: "b-none", state: "none", withAppleSource: true });
    const fetchMock = stubImageFetch();

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false, undefined, true);

    expect(result.requeued).toEqual(["b-none"]);
    expect(result.resolved).toEqual(["b-none"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/abc/1200x1200bb.jpg",
    );
    expect(put.mock.calls[0]?.[0]).toBe("albums/b-none.png");

    const healed = await albumRow("b-none");
    expect(healed?.image_state).toBe("resolved");
    expect(healed?.image_key).toBe("albums/b-none.png");
    expect(healed?.image_source).toBe("apple");
    expect(Number(healed?.image_failures)).toBe(0);
  });

  it("without retry, a terminal none row is NOT re-queued (the default is unchanged)", async () => {
    await seedAlbum({ slug: "stuck-none", state: "none", withAppleSource: true });
    stubImageFetch();

    const { bucket } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false, undefined, false);

    expect(result.requeued).toEqual([]);
    expect(result.requeuedCount).toBe(0);
    expect((await albumRow("stuck-none"))?.image_state).toBe("none");
  });

  it("retry=none on the artist kind re-queues artists and leaves albums untouched", async () => {
    await seedArtist({ imageUrl: "https://i.scdn.co/image/x", slug: "artist-none", state: "none" });
    await seedAlbum({ slug: "album-none", state: "none" });

    const { bucket } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "artist", 50, true, undefined, true);

    expect(result.requeued).toEqual(["artist-none"]);

    expect((await albumRow("album-none"))?.image_state).toBe("none");
  });

  it("retry albums require a usable source and prefer CAA over Spotify track covers", async () => {
    for (const slug of ["bare", "invalid-apple", "invalid-caa", "apple", "caa", "spotify"]) {
      await seedAlbum({
        slug,
        state: "none",
        withAppleSource: slug === "apple" || slug === "invalid-apple",
      });
    }
    await db.execute("update albums set artwork_width = 0 where slug = 'invalid-apple'");
    for (const [trackId, album, cover] of [
      ["bare-track", "bare", "https://example.com/cover.jpg"],
      ["invalid-caa-track", "invalid-caa", "https://coverartarchive.org/release/x/front-bad"],
      ["caa-spotify", "caa", "https://i.scdn.co/image/x"],
      ["caa-cover", "caa", "https://coverartarchive.org/release/x/front-500"],
      ["spotify-first", "spotify", "https://example.com/cover.jpg"],
      ["spotify-second", "spotify", "https://i.scdn.co/image/x"],
    ]) {
      if (trackId && album && cover) {
        await seedTrack(db, { logId: null, trackId });
        await db.execute({
          args: [`alb_${album}`, cover, trackId],
          sql: "update tracks set album_id = ?, album_image_url = ? where track_id = ?",
        });
      }
    }
    stubImageFetch(pngBytes(640, 640));
    const { bucket } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 24, false, undefined, true);
    expect(result.requeued).toEqual(["apple", "caa", "spotify"]);
    expect(result.resolved).toEqual(result.requeued);
    expect((await albumRow("apple"))?.image_source).toBe("apple");
    expect((await albumRow("caa"))?.image_source).toBe("coverart");
    expect((await albumRow("spotify"))?.image_source).toBe("spotify");
    expect((await albumRow("bare"))?.image_state).toBe("none");
  });

  it("retry artists require an accepted source and preserve pending image discovery", async () => {
    await seedArtist({ slug: "null-none", state: "none" });
    await seedArtist({ slug: "null-pending" });
    await seedArtist({
      imageUrl: "https://example.com/image/x",
      slug: "unaccepted",
      state: "none",
    });
    await seedArtist({ imageUrl: "https://i.scdn.co/image/x", slug: "spotify", state: "none" });
    await seedArtist({
      imageUrl: "https://cdn-images.dzcdn.net/images/artist/x.jpg",
      slug: "deezer",
      state: "none",
    });
    stubImageFetch(pngBytes(640, 640));
    const { bucket } = fakeBucket();
    const retry = await resolveCoverMasters(bucket, "artist", 24, false, undefined, true);
    expect(retry.requeued).toEqual(["deezer", "spotify"]);
    expect(retry.resolved).toEqual(retry.requeued);
    const normal = await resolveCoverMasters(bucket, "artist", 24, false);
    expect(normal.resolved).toEqual([]);
    expect(normal.none).toEqual([]);
    expect((await artistRow("null-pending"))?.image_state).toBe("pending");
    expect((await artistRow("null-none"))?.image_state).toBe("none");
    expect((await artistRow("unaccepted"))?.image_state).toBe("none");
  });

  it.each(["album", "artist"] as const)(
    "%s retry pages prioritise public findings and continue across tiers without dry-run writes",
    async (kind) => {
      for (const slug of ["a-unpublished", "b-catalogue", "y-public", "z-public"]) {
        if (kind === "album") {
          await seedAlbum({ slug, state: "none", withAppleSource: true });
        } else {
          await seedArtist({ imageUrl: "https://i.scdn.co/image/x", slug, state: "none" });
        }
        await seedTrack(db, {
          logId: slug.endsWith("public") ? `001.0.${slug}` : null,
          trackId: slug,
        });
        if (kind === "album") {
          await db.execute({
            args: [`alb_${slug}`, slug],
            sql: "update tracks set album_id = ? where track_id = ?",
          });
        } else {
          await db.execute({
            args: [`art_${slug}`, slug],
            sql: "insert into track_artists (artist_id, position, track_id) values (?, 0, ?)",
          });
        }
      }
      const { bucket, put } = fakeBucket();
      const first = await resolveCoverMasters(bucket, kind, 1, true, undefined, true);
      expect(first.requeued).toEqual(["y-public"]);
      expect(first.resolved).toEqual(first.requeued);
      expect(first.nextCursor).not.toBeNull();
      const second = await resolveCoverMasters(
        bucket,
        kind,
        1,
        true,
        first.nextCursor ?? undefined,
        true,
      );
      expect(second.requeued).toEqual(["z-public"]);
      const third = await resolveCoverMasters(
        bucket,
        kind,
        3,
        true,
        second.nextCursor ?? undefined,
        true,
      );
      expect(third.requeued).toEqual(["a-unpublished", "b-catalogue"]);
      expect(third.nextCursor).toBeNull();
      expect((await resolveCoverMasters(bucket, kind, 1, true, undefined, true)).requeued).toEqual(
        first.requeued,
      );
      expect(put).not.toHaveBeenCalled();
      expect(
        kind === "album"
          ? (await albumRow("y-public"))?.image_state
          : (await artistRow("y-public"))?.image_state,
      ).toBe("none");
    },
  );

  it("retry cooldown skips recent attempts and successive wet runs advance past definitive misses", async () => {
    await seedAlbum({
      attemptedAt: new Date().toISOString(),
      slug: "a-recent",
      state: "none",
      withAppleSource: true,
    });
    await seedAlbum({
      attemptedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      slug: "b-old",
      state: "none",
      withAppleSource: true,
    });
    await seedAlbum({ slug: "c-untried", state: "none", withAppleSource: true });
    const { bucket } = fakeBucket();
    const first = await resolveCoverMasters(bucket, "album", 1, false, undefined, true);
    expect(first.requeued).toEqual(["b-old"]);
    expect(first.none).toEqual(["b-old"]);
    expect(first.nextCursor).not.toBeNull();
    expect((await albumRow("b-old"))?.image_attempted_at).toEqual(expect.any(String));
    const nextPage = await resolveCoverMasters(
      bucket,
      "album",
      1,
      true,
      first.nextCursor ?? undefined,
      true,
    );
    expect(nextPage.requeued).toEqual(["c-untried"]);
    const nextRun = await resolveCoverMasters(bucket, "album", 24, false, undefined, true);
    expect(nextRun.requeued).toEqual(["c-untried"]);
    expect(
      (await resolveCoverMasters(bucket, "album", 24, false, undefined, true)).requeued,
    ).toEqual([]);
  });

  it("every statement binds exactly its placeholders across a wet retry pass (the arity guard)", async () => {
    await seedAlbum({ slug: "arity-none", state: "none", withAppleSource: true });
    stubImageFetch();

    executeCalls.length = 0;
    const { bucket } = fakeBucket();
    await resolveCoverMasters(bucket, "album", 50, false, undefined, true);

    expect(executeCalls.length).toBeGreaterThan(0);

    for (const call of executeCalls) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;
      expect({ argc: call.argc, placeholders, sql: call.sql.slice(0, 50) }).toMatchObject({
        argc: placeholders,
      });
    }
  });
});
