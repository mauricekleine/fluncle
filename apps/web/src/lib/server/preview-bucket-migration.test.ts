import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./hash";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { migratePreviewArchive } from "./preview-bucket-migration";

// REF-05 slice 4 — the public → private preview-bucket migration, driven against
// the REAL migrated schema (the in-memory libSQL harness applies every generated
// Drizzle migration, so `tracks.preview_archive_*` are byte-identical to prod) and
// FAKE R2 buckets. Every assertion here is provable offline: no R2, no network, no
// production. The load-bearing behaviours the task + review pin:
//   COPY:   a hash mismatch is SKIPPED never copied; dry-run mutates nothing; a
//           re-run is idempotent (a migrated row leaves the legacy set).
//   DELETE: the sweep is PREFIX-driven — an orphan with no DB row IS deleted; an
//           object whose logId has no private copy is SKIPPED not deleted; the
//           phase REFUSES while any legacy-prefixed row is still uncopied.
//   VERIFY: read-only — counts the prefix, mutates nothing.

// A minimal in-memory R2 bucket: enough of the `get`/`put`/`delete`/`list` surface
// the migration core uses. `get` returns objects with the `arrayBuffer()` + `size`
// the read-back verification reads; `list` paginates keys under a prefix (the cursor
// is the last key of the page, resumed with `key > cursor` — an opaque, monotonic
// stand-in for R2's cursor).
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

/** Set a track's archived-preview columns (seedTrack does not touch them). */
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

/** Seed one legacy-archived finding: bytes in the public bucket at the hash key. */
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

/** Put a public object at an arbitrary legacy key (used to seed ORPHANS). */
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
    // Copy mode NEVER deletes — the public object is left for the delete sweep.
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
    await setArchive(db, "t8", "iii.8H/preview.mp3"); // already migrated (private-scheme key)
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
    // The DB key is unchanged — the delete sweep never touches the pointer.
    expect(await keyOf(db, "t8")).toBe("iii.8H/preview.mp3");
  });

  it("DELETES an ORPHAN with no DB row (the prefix sweep is authoritative)", async () => {
    // A superseded hash: no `tracks` row points at this object, but the finding IS
    // migrated (its current private copy is present), so the orphan must be dropped.
    const orphan = await putPublicObject(publicBucket, "orph.9J", "deadbeef".repeat(8));
    await privateBucket.put("orph.9J/preview.mp3", bytesOf("current-private"));

    const result = await migratePreviewArchive({
      db, // empty DB — no rows at all
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
    await privateBucket.put("fmt.1A/preview.m4a", bytesOf("m4a-bytes")); // different ext

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
    // No private copy for nop.2B anywhere.

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
    expect(publicBucket.has(orphan)).toBe(true); // untouched — reported loudly instead
    expect(result.remaining).toBe(1); // still under the prefix
  });

  it("REFUSES to sweep while any legacy-prefixed DB row is still uncopied", async () => {
    // A finding still on the legacy prefix (not yet copied) blocks the whole phase.
    await seedLegacy(db, publicBucket, { body: "uncopied", logId: "blk.3C", trackId: "t-blk" });
    // And an unrelated migrated finding whose orphan would otherwise be swept.
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
    expect(result.remaining).toBe(1); // the one uncopied legacy row
    // NOTHING was deleted — not even the ready finding's orphan.
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
    expect(publicBucket.has(orphan)).toBe(true); // dry-run: nothing removed
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
    expect(first.remaining).toBe(1); // one object still under the prefix

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
    // A non-prefix object must NOT be counted.
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
    // Nothing mutated: the video + both previews are all still present.
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
