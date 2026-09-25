import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./hash";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { migratePreviewArchive } from "./preview-bucket-migration";

function fakeBucket() {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>();

  return {
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async get(key: string) {
      const entry = store.get(key);

      if (!entry) {
        return null;
      }

      return {
        arrayBuffer: async (): Promise<ArrayBuffer> => entry.body,
        httpMetadata: { contentType: entry.contentType },
        size: entry.body.byteLength,
      };
    },
    has(key: string): boolean {
      return store.has(key);
    },
    async head(key: string) {
      const entry = store.get(key);

      return entry ? { size: entry.body.byteLength } : null;
    },
    keys(): string[] {
      return [...store.keys()];
    },
    async list(options: { cursor?: string; limit?: number; prefix: string }) {
      const cursor = options.cursor;
      const all = [...store.keys()].filter((key) => key.startsWith(options.prefix)).sort();
      const begin = cursor ? all.findIndex((key) => key > cursor) : 0;
      const offset = begin === -1 ? all.length : begin;
      const pageLimit = options.limit ?? 1000;
      const page = all.slice(offset, offset + pageLimit);
      const truncated = offset + pageLimit < all.length;

      return {
        cursor: truncated ? page[page.length - 1] : undefined,
        objects: page.map((key) => ({ key })),
        truncated,
      };
    },
    async put(
      key: string,
      value: ArrayBuffer,
      putOptions?: { httpMetadata?: { contentType?: string } },
    ): Promise<void> {
      store.set(key, { body: value, contentType: putOptions?.httpMetadata?.contentType });
    },
  };
}

type FakeBucket = ReturnType<typeof fakeBucket>;

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function setArchive(
  db: Client,
  trackId: string,
  key: string,
  mime = "audio/mpeg",
): Promise<void> {
  await db.execute({
    args: [key, mime, "deezer:stored", "2026-06-01T00:00:00.000Z", trackId],
    sql: `update tracks
          set preview_archive_key = ?, preview_archive_mime = ?,
              preview_archive_source = ?, preview_archived_at = ?
          where track_id = ?`,
  });
}

async function keyOf(db: Client, trackId: string): Promise<string | null> {
  const result = await db.execute({
    args: [trackId],
    sql: "select preview_archive_key from tracks where track_id = ?",
  });

  const value = result.rows[0]?.preview_archive_key;

  return typeof value === "string" ? value : null;
}

async function seedLegacy(
  db: Client,
  publicBucket: FakeBucket,
  args: { body: string; ext?: string; logId: string; trackId: string },
): Promise<string> {
  const ext = args.ext ?? "mp3";
  const bytes = bytesOf(args.body);
  const hash = await sha256Hex(bytes);
  const oldKey = `analysis/previews/${args.logId}/${hash}.${ext}`;

  await seedTrack(db, { logId: args.logId, trackId: args.trackId });
  await setArchive(db, args.trackId, oldKey);
  await publicBucket.put(oldKey, bytes, { httpMetadata: { contentType: "audio/mpeg" } });

  return oldKey;
}

async function putPublicObject(
  publicBucket: FakeBucket,
  logId: string,
  hashOrName: string,
  ext = "mp3",
): Promise<string> {
  const key = `analysis/previews/${logId}/${hashOrName}.${ext}`;
  await publicBucket.put(key, bytesOf(`bytes-for-${key}`));

  return key;
}

describe("migratePreviewArchive — copy mode", () => {
  let db: Client;
  let publicBucket: FakeBucket;
  let privateBucket: FakeBucket;

  beforeEach(async () => {
    db = await createIntegrationDb();
    publicBucket = fakeBucket();
    privateBucket = fakeBucket();
  });

  it("copies a verified legacy preview into the private bucket and rewrites the DB key", async () => {
    await seedLegacy(db, publicBucket, {
      body: "the-preview-bytes",
      logId: "aaa.1A",
      trackId: "t1",
    });

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.mode).toBe("copy");
    expect(result.copiedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.copied[0]).toMatchObject({
      logId: "aaa.1A",
      newKey: "aaa.1A/preview.mp3",
      trackId: "t1",
    });

    expect(privateBucket.has("aaa.1A/preview.mp3")).toBe(true);
    expect(await keyOf(db, "t1")).toBe("aaa.1A/preview.mp3");

    expect(publicBucket.keys()).toHaveLength(1);
  });

  it("preserves the private bytes exactly (read-back verification passes on real bytes)", async () => {
    await seedLegacy(db, publicBucket, { body: "exact-bytes-🎧", logId: "bbb.2B", trackId: "t2" });

    await migratePreviewArchive({ db, dryRun: false, limit: 50, privateBucket, publicBucket });

    const stored = await privateBucket.get("bbb.2B/preview.mp3");
    expect(stored).not.toBeNull();
    const text = new TextDecoder().decode(
      await (stored?.arrayBuffer() ?? Promise.resolve(new ArrayBuffer(0))),
    );
    expect(text).toBe("exact-bytes-🎧");
  });

  it("SKIPS a hash mismatch — never copies, never rewrites (the corruption guard)", async () => {
    const bytes = bytesOf("real-bytes");
    const claimedHash = await sha256Hex(bytesOf("different-bytes"));
    const oldKey = `analysis/previews/ccc.3C/${claimedHash}.mp3`;
    await seedTrack(db, { logId: "ccc.3C", trackId: "t3" });
    await setArchive(db, "t3", oldKey);
    await publicBucket.put(oldKey, bytes);

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.copiedCount).toBe(0);
    expect(result.skipped).toEqual([{ reason: "hash_mismatch", trackId: "t3" }]);
    expect(privateBucket.keys()).toHaveLength(0);
    expect(await keyOf(db, "t3")).toBe(oldKey);
  });

  it("DRY-RUN mutates nothing — no private write, no DB rewrite", async () => {
    const oldKey = await seedLegacy(db, publicBucket, {
      body: "dry-run-bytes",
      logId: "ddd.4D",
      trackId: "t4",
    });

    const result = await migratePreviewArchive({
      db,
      dryRun: true,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.dryRun).toBe(true);
    expect(result.copiedCount).toBe(1);
    expect(result.copied[0]).toMatchObject({ newKey: "ddd.4D/preview.mp3", trackId: "t4" });
    expect(privateBucket.keys()).toHaveLength(0);
    expect(await keyOf(db, "t4")).toBe(oldKey);
  });

  it("is idempotent — a migrated row leaves the legacy set, a re-run copies nothing", async () => {
    await seedLegacy(db, publicBucket, { body: "idem", logId: "eee.5E", trackId: "t5" });

    const first = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });
    expect(first.copiedCount).toBe(1);

    const second = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });
    expect(second.copiedCount).toBe(0);
    expect(second.skippedCount).toBe(0);
    expect(second.remaining).toBe(0);
    expect(second.nextCursor).toBeNull();
    expect(privateBucket.keys()).toEqual(["eee.5E/preview.mp3"]);
    expect(await keyOf(db, "t5")).toBe("eee.5E/preview.mp3");
  });

  it("skips a legacy row whose public object is gone", async () => {
    const claimedHash = await sha256Hex(bytesOf("gone"));
    await seedTrack(db, { logId: "fff.6F", trackId: "t6" });
    await setArchive(db, "t6", `analysis/previews/fff.6F/${claimedHash}.mp3`);

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.copiedCount).toBe(0);
    expect(result.skipped).toEqual([{ reason: "public_object_missing", trackId: "t6" }]);
  });

  it("batches + resumes: a full batch returns nextCursor + remaining", async () => {
    await seedLegacy(db, publicBucket, { body: "b1", logId: "g1.1A", trackId: "t1" });
    await seedLegacy(db, publicBucket, { body: "b2", logId: "g2.1A", trackId: "t2" });
    await seedLegacy(db, publicBucket, { body: "b3", logId: "g3.1A", trackId: "t3" });

    const first = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 2,
      privateBucket,
      publicBucket,
    });
    expect(first.copiedCount).toBe(2);
    expect(first.nextCursor).toBe("t2");
    expect(first.remaining).toBe(1);

    const second = await migratePreviewArchive({
      cursor: first.nextCursor ?? undefined,
      db,
      dryRun: false,
      limit: 2,
      privateBucket,
      publicBucket,
    });
    expect(second.copiedCount).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(second.remaining).toBe(0);
    expect(privateBucket.keys()).toHaveLength(3);
  });

  it("leaves a born-private / already-private row untouched (not on the legacy prefix)", async () => {
    await seedTrack(db, { logId: "hhh.7G", trackId: "t7" });
    await setArchive(db, "t7", "hhh.7G/preview.mp3");

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.copiedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(await keyOf(db, "t7")).toBe("hhh.7G/preview.mp3");
  });
});

describe("migratePreviewArchive — delete mode (prefix sweep)", () => {
  let db: Client;
  let publicBucket: FakeBucket;
  let privateBucket: FakeBucket;

  beforeEach(async () => {
    db = await createIntegrationDb();
    publicBucket = fakeBucket();
    privateBucket = fakeBucket();
  });

  it("deletes a public object whose finding has a present private copy", async () => {
    const bytes = bytesOf("migrated-bytes");
    const hash = await sha256Hex(bytes);
    const oldKey = `analysis/previews/iii.8H/${hash}.mp3`;
    await seedTrack(db, { logId: "iii.8H", trackId: "t8" });
    await setArchive(db, "t8", "iii.8H/preview.mp3");
    await privateBucket.put("iii.8H/preview.mp3", bytes);
    await publicBucket.put(oldKey, bytes);

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.mode).toBe("delete");
    expect(result.blocked).toBeNull();
    expect(result.deletedCount).toBe(1);
    expect(result.deleted[0]).toMatchObject({ oldKey, trackId: "iii.8H" });
    expect(publicBucket.has(oldKey)).toBe(false);
    expect(privateBucket.has("iii.8H/preview.mp3")).toBe(true);
    expect(result.remaining).toBe(0);

    expect(await keyOf(db, "t8")).toBe("iii.8H/preview.mp3");
  });

  it("DELETES an ORPHAN with no DB row (the prefix sweep is authoritative)", async () => {
    const orphan = await putPublicObject(publicBucket, "orph.9J", "deadbeef".repeat(8));
    await privateBucket.put("orph.9J/preview.mp3", bytesOf("current-private"));

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(1);
    expect(result.deleted[0]).toMatchObject({ oldKey: orphan, trackId: "orph.9J" });
    expect(publicBucket.has(orphan)).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("finds the private copy across a container change (orphan .mp3 → private .m4a)", async () => {
    const orphan = await putPublicObject(publicBucket, "fmt.1A", "a".repeat(64), "mp3");
    await privateBucket.put("fmt.1A/preview.m4a", bytesOf("m4a-bytes"));

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(1);
    expect(result.deleted[0]).toMatchObject({ oldKey: orphan, trackId: "fmt.1A" });
    expect(publicBucket.has(orphan)).toBe(false);
  });

  it("SKIPS (does not delete) an object whose logId has no private copy", async () => {
    const orphan = await putPublicObject(publicBucket, "nop.2B", "b".repeat(64));

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(0);
    expect(result.skipped).toEqual([{ reason: "private_copy_absent", trackId: "nop.2B" }]);
    expect(publicBucket.has(orphan)).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("REFUSES to sweep while any legacy-prefixed DB row is still uncopied", async () => {
    await seedLegacy(db, publicBucket, { body: "uncopied", logId: "blk.3C", trackId: "t-blk" });

    const orphan = await putPublicObject(publicBucket, "rdy.4D", "c".repeat(64));
    await privateBucket.put("rdy.4D/preview.mp3", bytesOf("ready"));

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.blocked).toBe("legacy_rows_uncopied");
    expect(result.deletedCount).toBe(0);
    expect(result.remaining).toBe(1);

    expect(publicBucket.has(orphan)).toBe(true);
  });

  it("DRY-RUN delete reports the targets but removes nothing", async () => {
    const orphan = await putPublicObject(publicBucket, "dry.5E", "d".repeat(64));
    await privateBucket.put("dry.5E/preview.mp3", bytesOf("present"));

    const result = await migratePreviewArchive({
      db,
      dryRun: true,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(1);
    expect(result.deleted[0]).toMatchObject({ oldKey: orphan, trackId: "dry.5E" });
    expect(publicBucket.has(orphan)).toBe(true);
  });

  it("is idempotent — a second sweep of an emptied prefix deletes nothing", async () => {
    await putPublicObject(publicBucket, "idem.6F", "e".repeat(64));
    await privateBucket.put("idem.6F/preview.mp3", bytesOf("present"));

    const first = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });
    expect(first.deletedCount).toBe(1);

    const second = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket,
      publicBucket,
    });
    expect(second.deletedCount).toBe(0);
    expect(second.remaining).toBe(0);
    expect(second.nextCursor).toBeNull();
  });

  it("paginates the prefix sweep by the R2 list cursor", async () => {
    for (const n of ["1A", "2B", "3C"]) {
      await putPublicObject(publicBucket, `pg.${n}`, "f".repeat(64));
      await privateBucket.put(`pg.${n}/preview.mp3`, bytesOf(`p-${n}`));
    }

    const first = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 2,
      mode: "delete",
      privateBucket,
      publicBucket,
    });
    expect(first.deletedCount).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.remaining).toBe(1);

    const second = await migratePreviewArchive({
      cursor: first.nextCursor ?? undefined,
      db,
      dryRun: false,
      limit: 2,
      mode: "delete",
      privateBucket,
      publicBucket,
    });
    expect(second.deletedCount).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(second.remaining).toBe(0);
  });

  it("probes private-copy PRESENCE concurrently via head, never a body-reading get", async () => {
    await putPublicObject(publicBucket, "cc1.1A", "a".repeat(64));
    await putPublicObject(publicBucket, "cc2.2B", "b".repeat(64));

    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const present = new Set(["cc1.1A/preview.mp3", "cc2.2B/preview.mp3"]);

    const spyPrivate = {
      get: (_key: string) => {
        calls.push("get");

        return Promise.resolve(null);
      },
      async head(key: string) {
        calls.push("head");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;

        return present.has(key) ? { size: 1 } : null;
      },
      put: (_key: string, _value: ArrayBuffer) => Promise.resolve(),
    };

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: 50,
      mode: "delete",
      privateBucket: spyPrivate,
      publicBucket,
    });

    expect(result.deletedCount).toBe(2);
    expect(calls).not.toContain("get");
    expect(calls.filter((call) => call === "head").length).toBeGreaterThan(1);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("keeps results PAGE-ORDERED across the concurrency-chunk boundary", async () => {
    const total = 25;
    const expectedDeleted: string[] = [];
    const expectedSkipped: string[] = [];

    for (let i = 0; i < total; i += 1) {
      const logId = `p${String(i).padStart(2, "0")}`;
      const key = await putPublicObject(publicBucket, logId, "a".repeat(64));

      if (i % 2 === 0) {
        await privateBucket.put(`${logId}/preview.mp3`, bytesOf(`v-${logId}`));
        expectedDeleted.push(key);
      } else {
        expectedSkipped.push(logId);
      }
    }

    const result = await migratePreviewArchive({
      db,
      dryRun: false,
      limit: total,
      mode: "delete",
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(expectedDeleted.length);
    expect(result.deleted.map((entry) => entry.oldKey)).toEqual(expectedDeleted);
    expect(result.skipped.map((entry) => entry.trackId)).toEqual(expectedSkipped);
    expect(result.remaining).toBe(expectedSkipped.length);
  });
});

describe("migratePreviewArchive — verify mode (read-only)", () => {
  let db: Client;
  let publicBucket: FakeBucket;
  let privateBucket: FakeBucket;

  beforeEach(async () => {
    db = await createIntegrationDb();
    publicBucket = fakeBucket();
    privateBucket = fakeBucket();
  });

  it("counts the objects under the prefix and returns a sample, mutating nothing", async () => {
    await putPublicObject(publicBucket, "v1.1A", "1".repeat(64));
    await putPublicObject(publicBucket, "v2.2B", "2".repeat(64));

    await publicBucket.put("019.F.1A/set.mp4", bytesOf("a video"));

    const result = await migratePreviewArchive({
      db,
      limit: 50,
      mode: "verify",
      privateBucket,
      publicBucket,
    });

    expect(result.mode).toBe("verify");
    expect(result.dryRun).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.sampleKeys).toHaveLength(2);
    expect(result.sampleKeys.every((key) => key.startsWith("analysis/previews/"))).toBe(true);

    expect(publicBucket.keys()).toHaveLength(3);
    expect(result.deletedCount).toBe(0);
  });

  it("reports zero for an empty prefix (the operator's post-purge proof)", async () => {
    const result = await migratePreviewArchive({
      db,
      limit: 50,
      mode: "verify",
      privateBucket,
      publicBucket,
    });

    expect(result.remaining).toBe(0);
    expect(result.sampleKeys).toEqual([]);
  });
});
