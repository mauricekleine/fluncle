import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./hash";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { migratePreviewArchive } from "./preview-bucket-migration";

// REF-05 slice 4 — the public → private preview-bucket migration, driven against
// the REAL migrated schema (the in-memory libSQL harness applies every generated
// Drizzle migration, so `tracks.preview_archive_*` are byte-identical to prod) and
// FAKE R2 buckets. Every assertion here is provable offline: no R2, no network, no
// production. The four load-bearing behaviours the task pins:
//   - a hash mismatch is SKIPPED, never copied;
//   - a re-run is idempotent (a migrated row leaves the legacy set);
//   - dry-run mutates NOTHING (no bucket write, no DB rewrite);
//   - Phase B REFUSES to delete when the private copy is absent.

// A minimal in-memory R2 bucket: enough of the `get`/`put`/`delete` surface the
// migration core uses, returning objects with the `arrayBuffer()` + `size` the
// read-back verification reads.
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
    async put(
      key: string,
      value: ArrayBuffer,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<void> {
      store.set(key, { body: value, contentType: options?.httpMetadata?.contentType });
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

describe("migratePreviewArchive — copy phase (A)", () => {
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

    expect(result.copiedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.copied[0]).toMatchObject({
      logId: "aaa.1A",
      newKey: "aaa.1A/preview.mp3",
      trackId: "t1",
    });

    // The private bucket now holds the bytes at the new key…
    expect(privateBucket.has("aaa.1A/preview.mp3")).toBe(true);
    // …and the DB pointer is rewritten to it.
    expect(await keyOf(db, "t1")).toBe("aaa.1A/preview.mp3");
    // The public object is LEFT IN PLACE (copy phase never deletes).
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
    // Seed a legacy row whose key claims a hash that does NOT match the bytes: put
    // the wrong bytes at the claimed key.
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
    // Nothing written to the private bucket, DB key untouched.
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

    // It REPORTS the copy it would make…
    expect(result.dryRun).toBe(true);
    expect(result.copiedCount).toBe(1);
    expect(result.copied[0]).toMatchObject({ newKey: "ddd.4D/preview.mp3", trackId: "t4" });
    // …but changes nothing.
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
    // Still exactly one private object; the key is unchanged.
    expect(privateBucket.keys()).toEqual(["eee.5E/preview.mp3"]);
    expect(await keyOf(db, "t5")).toBe("eee.5E/preview.mp3");
  });

  it("skips a legacy row whose public object is gone", async () => {
    const claimedHash = await sha256Hex(bytesOf("gone"));
    await seedTrack(db, { logId: "fff.6F", trackId: "t6" });
    await setArchive(db, "t6", `analysis/previews/fff.6F/${claimedHash}.mp3`);
    // Intentionally do NOT put the object in the public bucket.

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
    // Three legacy rows, ordered by track_id t1<t2<t3; a limit of 2 leaves 1.
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

describe("migratePreviewArchive — delete phase (B)", () => {
  let db: Client;
  let publicBucket: FakeBucket;
  let privateBucket: FakeBucket;

  beforeEach(async () => {
    db = await createIntegrationDb();
    publicBucket = fakeBucket();
    privateBucket = fakeBucket();
  });

  it("deletes the reconstructed public object once the private copy is confirmed present", async () => {
    // A finding already migrated: DB key private, bytes in BOTH buckets (public =
    // the still-leaking original at the hash key it must reconstruct + delete).
    const bytes = bytesOf("migrated-bytes");
    const hash = await sha256Hex(bytes);
    const oldKey = `analysis/previews/iii.8H/${hash}.mp3`;
    await seedTrack(db, { logId: "iii.8H", trackId: "t8" });
    await setArchive(db, "t8", "iii.8H/preview.mp3");
    await privateBucket.put("iii.8H/preview.mp3", bytes);
    await publicBucket.put(oldKey, bytes);

    const result = await migratePreviewArchive({
      db,
      deletePublic: true,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.deletePublic).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(result.deleted[0]).toMatchObject({ oldKey, trackId: "t8" });
    // The public leak is gone; the private copy stays.
    expect(publicBucket.has(oldKey)).toBe(false);
    expect(privateBucket.has("iii.8H/preview.mp3")).toBe(true);
    // The DB key is unchanged — delete phase never touches the pointer.
    expect(await keyOf(db, "t8")).toBe("iii.8H/preview.mp3");
  });

  it("REFUSES to delete when the private copy is absent (the safety gate)", async () => {
    const bytes = bytesOf("unsafe");
    const hash = await sha256Hex(bytes);
    const oldKey = `analysis/previews/jjj.9J/${hash}.mp3`;
    await seedTrack(db, { logId: "jjj.9J", trackId: "t9" });
    await setArchive(db, "t9", "jjj.9J/preview.mp3");
    // The public object still exists…
    await publicBucket.put(oldKey, bytes);
    // …but the private bucket has NOTHING. Deletion must refuse.

    const result = await migratePreviewArchive({
      db,
      deletePublic: true,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(0);
    expect(result.skipped).toEqual([{ reason: "private_copy_absent", trackId: "t9" }]);
    // The public object is UNTOUCHED (we could not confirm a safe private twin).
    expect(publicBucket.has(oldKey)).toBe(true);
  });

  it("DRY-RUN delete reports the target but removes nothing", async () => {
    const bytes = bytesOf("dry-del");
    const hash = await sha256Hex(bytes);
    const oldKey = `analysis/previews/kkk.1K/${hash}.mp3`;
    await seedTrack(db, { logId: "kkk.1K", trackId: "t10" });
    await setArchive(db, "t10", "kkk.1K/preview.mp3");
    await privateBucket.put("kkk.1K/preview.mp3", bytes);
    await publicBucket.put(oldKey, bytes);

    const result = await migratePreviewArchive({
      db,
      deletePublic: true,
      dryRun: true,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(1);
    expect(result.deleted[0]).toMatchObject({ oldKey, trackId: "t10" });
    // Nothing actually removed.
    expect(publicBucket.has(oldKey)).toBe(true);
  });

  it("no-ops a born-private preview (private present, no public twin) and is idempotent", async () => {
    const bytes = bytesOf("born-private");
    await seedTrack(db, { logId: "lll.2L", trackId: "t11" });
    await setArchive(db, "t11", "lll.2L/preview.mp3");
    await privateBucket.put("lll.2L/preview.mp3", bytes);
    // No public object exists for this finding.

    const result = await migratePreviewArchive({
      db,
      deletePublic: true,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(0);
    expect(result.skipped).toEqual([{ reason: "public_already_absent", trackId: "t11" }]);

    // A re-run is a clean no-op (idempotent).
    const again = await migratePreviewArchive({
      db,
      deletePublic: true,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });
    expect(again.deletedCount).toBe(0);
    expect(again.skippedCount).toBe(1);
  });

  it("does not consider legacy-prefixed rows in the delete phase", async () => {
    // A row still on the legacy prefix belongs to phase A, never phase B.
    await seedLegacy(db, publicBucket, { body: "still-legacy", logId: "mmm.3M", trackId: "t12" });

    const result = await migratePreviewArchive({
      db,
      deletePublic: true,
      dryRun: false,
      limit: 50,
      privateBucket,
      publicBucket,
    });

    expect(result.deletedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });
});
