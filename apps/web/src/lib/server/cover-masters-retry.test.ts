// The `retry=none` operator heal for the owned-cover-master sweep, proven against the REAL migrated
// schema on an in-memory libSQL engine (the label-lineage.test.ts harness): `getDb` is mocked to
// hand back a fresh `:memory:` client with every generated migration applied, so the REAL
// `cover-masters.ts` re-queue SQL runs against the REAL `albums`/`artists` tables — which means a
// placeholder/arg MISMATCH throws for real (the arity guard, pinned explicitly below too). `fetch`
// and the R2 bucket are stubbed, so no test hits the network or R2.
//
// The load-bearing acceptance: `retry=none` re-queues ONLY the kind's terminal `none` rows (a
// `resolved` / `pending` row is untouched, the OTHER kind is untouched), it resets the failure
// counter + clears the attempt stamp, a dry run reports without writing, and the SAME-call pass
// then re-walks the ladder on a re-queued row.

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

import { resolveCoverMasters } from "./cover-masters";
import { createIntegrationDb } from "./integration-db";

let db: Client;

// Records every {sql, args} the sweep issues, so one test can pin placeholder-count == arg-count
// across a full wet pass (the label-lineage.test.ts arity guard, applied to real execution).
const executeCalls: Array<{ argc: number; sql: string }> = [];

const APPLE_TEMPLATE = "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg";

/** A minimal PNG whose IHDR carries `w`×`h` — the readImageSize path the cap guard reads. */
function pngBytes(w: number, h: number): ArrayBuffer {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452); // "IHDR"
  view.setUint32(16, w);
  view.setUint32(20, h);

  return buf;
}

/** A fake R2 bucket that records its `put`s. */
function fakeBucket() {
  const put = vi.fn(
    (_key: string, _value: ArrayBuffer | string, _options?: unknown): Promise<undefined> =>
      Promise.resolve(undefined),
  );

  return { bucket: { put } as unknown as Pick<R2Bucket, "put">, put };
}

/** Stub `fetch` to return a valid ≤1200 PNG for every source URL. */
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

  // Wrap execute so the arity guard test can inspect every statement (real SQL still executes, so a
  // mismatch also throws for real).
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveCoverMasters — retry=none re-queues terminal none rows", () => {
  it("dry run re-queues ONLY the kind's terminal none rows and writes nothing", async () => {
    await seedAlbum({ slug: "none-1", state: "none" });
    await seedAlbum({ slug: "none-2", state: "none" });
    await seedAlbum({ imageKey: "albums/resolved-1.jpg", slug: "resolved-1", state: "resolved" });
    await seedAlbum({ slug: "pending-1", state: "pending" });
    await seedArtist({ imageUrl: "https://i.scdn.co/image/x", slug: "artist-none", state: "none" });

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, true, undefined, true);

    // Only the two terminal-none ALBUM rows would re-queue, slug-ordered.
    expect(result.requeued).toEqual(["none-1", "none-2"]);
    expect(result.requeuedCount).toBe(2);
    expect(result.dryRun).toBe(true);

    // Nothing written: every row keeps its state, and no R2 put.
    expect(put).not.toHaveBeenCalled();
    expect((await albumRow("none-1"))?.image_state).toBe("none");
    expect((await albumRow("none-2"))?.image_state).toBe("none");
    expect((await albumRow("resolved-1"))?.image_state).toBe("resolved");
    expect((await albumRow("resolved-1"))?.image_key).toBe("albums/resolved-1.jpg");
    expect((await albumRow("pending-1"))?.image_state).toBe("pending");
    // The OTHER kind is untouched.
    expect((await artistRow("artist-none"))?.image_state).toBe("none");
  });

  it("wet re-queue resets the failure counter + clears the attempt stamp (row left pending)", async () => {
    // `a-pending` sorts before `z-none`, so with limit=1 the pass processes `a-pending` and leaves
    // the re-queued `z-none` observable as pending — isolating what the RE-QUEUE itself wrote.
    await seedAlbum({ slug: "a-pending", state: "pending", withAppleSource: true });
    await seedAlbum({
      attemptedAt: new Date().toISOString(),
      failures: 5,
      slug: "z-none",
      state: "none",
      withAppleSource: true,
    });
    stubImageFetch();

    const { bucket } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 1, false, undefined, true);

    expect(result.requeued).toEqual(["z-none"]);
    // The pass processed the slug-first pending row, not the re-queued one.
    expect(result.resolved).toEqual(["a-pending"]);

    const requeued = await albumRow("z-none");
    expect(requeued?.image_state).toBe("pending");
    expect(Number(requeued?.image_failures)).toBe(0);
    expect(requeued?.image_attempted_at).toBeNull();
  });

  it("the SAME call then re-walks the ladder and mints a master for a re-queued row", async () => {
    await seedAlbum({ failures: 5, slug: "b-none", state: "none", withAppleSource: true });
    const fetchMock = stubImageFetch();

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false, undefined, true);

    expect(result.requeued).toEqual(["b-none"]);
    expect(result.resolved).toEqual(["b-none"]);
    // Apple's ≤1200 substitution was fetched, and a master was put.
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
    // The OTHER kind's terminal none row is untouched.
    expect((await albumRow("album-none"))?.image_state).toBe("none");
  });

  it("every statement binds exactly its placeholders across a wet retry pass (the arity guard)", async () => {
    await seedAlbum({ slug: "arity-none", state: "none", withAppleSource: true });
    stubImageFetch();

    executeCalls.length = 0; // ignore the seed inserts; measure only the sweep's statements
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
