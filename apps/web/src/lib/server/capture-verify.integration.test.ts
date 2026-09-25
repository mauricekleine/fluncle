import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COUNT_UNVERIFIED_CAPTURES_SQL,
  countUnverifiedCaptures,
  listUnverifiedCaptures,
  verifyCapture,
  WRONG_AUDIO_STATUS,
} from "./catalogue";
import {
  createIntegrationDb,
  seedArtist,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

async function capture(trackId: string, sha: string): Promise<void> {
  await db.execute({
    args: [`catalogue/${trackId}/${sha}.webm`, trackId],
    sql: `update tracks set source_audio_key = ?, capture_status = 'done',
          source_audio_captured_at = '2026-07-01T00:00:00.000Z' where track_id = ?`,
  });
}

async function embed(trackId: string): Promise<void> {
  await seedEmbedding(
    db,
    trackId,
    Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)),
  );
}

type Row = {
  capture_priority: null | number;
  capture_status: string;
  capture_verification: null | string;
  capture_verified_at: null | string;
  embedding_blob: unknown;
  source_audio_rejected: null | string;
};

async function readRow(trackId: string): Promise<Row> {
  const result = await db.execute({
    args: [trackId],

    sql: `select t.capture_status, t.capture_verification, t.capture_verified_at,
                 t.capture_priority, emb.embedding_blob, t.source_audio_rejected
          from tracks t
          left join track_embeddings emb on emb.track_id = t.track_id
          where t.track_id = ?`,
  });

  return result.rows[0] as unknown as Row;
}

const SHA = "a".repeat(64);

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("verifyCapture — the verdict routing", () => {
  it("stamps a MATCH `preview-match` and takes the row off the worklist", async () => {
    await seedCatalogueTrack(db, { trackId: "cat_ok" });
    await capture("cat_ok", SHA);

    expect(await verifyCapture("cat_ok", "match")).toBe("preview-match");

    const row = await readRow("cat_ok");

    expect(row.capture_verification).toBe("preview-match");
    expect(row.capture_verified_at).not.toBeNull();

    expect((await listUnverifiedCaptures()).map((item) => item.trackId)).not.toContain("cat_ok");
  });

  it("stamps NO-PREVIEW `unverified` — the honest abstain, never a block", async () => {
    await seedCatalogueTrack(db, { trackId: "cat_nopreview" });
    await capture("cat_nopreview", SHA);

    expect(await verifyCapture("cat_nopreview", "no-preview")).toBe("unverified");
    expect((await readRow("cat_nopreview")).capture_verification).toBe("unverified");
  });

  it("QUARANTINES a catalogue MISMATCH: rewound, sha remembered, back in the capture queue", async () => {
    await db.execute({
      args: ["lbl-seed", "Critical Music", "critical-music", "enabled"],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values (?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    });
    await seedCatalogueTrack(db, { label: "Critical Music", trackId: "cat_wrong" });
    await capture("cat_wrong", SHA);
    await embed("cat_wrong");
    await seedArtist(db, { id: "verify-artist", slug: "verify-artist" });
    await db.execute(`insert into track_artists (track_id, artist_id, position)
      values ('cat_wrong', 'verify-artist', 0)`);
    await db.execute("update tracks set key = '8A' where track_id = 'cat_wrong'");
    await db.execute("update artists set rankable_track_count = 1 where id = 'verify-artist'");

    expect(await verifyCapture("cat_wrong", "mismatch")).toBe("quarantined-catalogue");
    expect(
      (await db.execute("select rankable_track_count from artists where id = 'verify-artist'"))
        .rows[0]?.rankable_track_count,
    ).toBe(0);

    const row = await readRow("cat_wrong");

    expect(row.capture_status).toBe(WRONG_AUDIO_STATUS);
    expect(row.embedding_blob).toBeNull();
    expect(row.capture_priority).toBe(1);

    expect(row.capture_verification).toBe("mismatch");

    const rejected = JSON.parse(row.source_audio_rejected ?? "[]") as { sha256: string }[];

    expect(rejected.map((entry) => entry.sha256)).toContain(SHA);
  });

  it("only STAMPS a finding MISMATCH — a machine never rewinds a public finding", async () => {
    await seedTrack(db, { logId: "005.9.9L", trackId: "find_wrong" });
    await capture("find_wrong", SHA);
    await embed("find_wrong");

    expect(await verifyCapture("find_wrong", "mismatch")).toBe("flagged-finding");

    const row = await readRow("find_wrong");

    expect(row.capture_verification).toBe("mismatch");

    expect(row.capture_status).toBe("done");
    expect(row.embedding_blob).not.toBeNull();
    expect(row.source_audio_rejected).toBeNull();
  });

  it("RE-CHECKS a CONSENSUS-VERIFIED capture like any other — machine evidence gets no pass", async () => {
    await seedTrack(db, { logId: "012.3.4B", trackId: "find_consensus" });
    await capture("find_consensus", SHA);
    await embed("find_consensus");
    await db.execute({
      sql: `update tracks set capture_verification = 'consensus-verified',
                              capture_verified_at = '2026-07-02T00:00:00.000Z'
            where track_id = 'find_consensus'`,
    });

    expect(await verifyCapture("find_consensus", "mismatch")).toBe("flagged-finding");
    expect((await readRow("find_consensus")).capture_verification).toBe("mismatch");

    await db.execute({
      sql: `update tracks set capture_verification = 'consensus-verified'
            where track_id = 'find_consensus'`,
    });
    expect(await verifyCapture("find_consensus", "match")).toBe("preview-match");
    expect((await readRow("find_consensus")).capture_verification).toBe("preview-match");
  });

  it("steps aside from an OPERATOR-VERIFIED capture — never flags, never quarantines what the operator chose", async () => {
    await seedTrack(db, { logId: "012.3.4A", trackId: "find_pinned" });
    await capture("find_pinned", SHA);
    await embed("find_pinned");
    await seedCatalogueTrack(db, { trackId: "cat_pinned" });
    await capture("cat_pinned", SHA);
    await embed("cat_pinned");
    await db.execute({
      sql: `update tracks set capture_verification = 'operator-verified',
                              capture_verified_at = '2026-07-02T00:00:00.000Z',
                              capture_source_pin = 'dQw4w9WgXcQ'
            where track_id in ('find_pinned', 'cat_pinned')`,
    });

    expect(await verifyCapture("find_pinned", "mismatch")).toBe("operator-verified");
    expect(await verifyCapture("cat_pinned", "mismatch")).toBe("operator-verified");

    for (const trackId of ["find_pinned", "cat_pinned"]) {
      const row = await readRow(trackId);

      expect(row.capture_verification).toBe("operator-verified");
      expect(row.capture_verified_at).toBe("2026-07-02T00:00:00.000Z");
      expect(row.capture_status).toBe("done");
      expect(row.embedding_blob).not.toBeNull();
      expect(row.source_audio_rejected).toBeNull();
    }

    const queued = (await listUnverifiedCaptures()).map((item) => item.trackId);

    expect(queued).not.toContain("find_pinned");
    expect(queued).not.toContain("cat_pinned");
  });

  it("is a `not-captured` no-op on a row with no audio, and on an already-quarantined row", async () => {
    await seedCatalogueTrack(db, { trackId: "cat_bare" });

    expect(await verifyCapture("cat_bare", "match")).toBe("not-captured");
    expect((await readRow("cat_bare")).capture_verification).toBeNull();

    await seedCatalogueTrack(db, { trackId: "cat_quarantined" });
    await capture("cat_quarantined", SHA);
    await db.execute({
      args: [WRONG_AUDIO_STATUS, "cat_quarantined"],
      sql: `update tracks set capture_status = ? where track_id = ?`,
    });

    expect(await verifyCapture("cat_quarantined", "match")).toBe("not-captured");
  });
});

describe("listUnverifiedCaptures — the backfill's worklist", () => {
  it("serves captured, unverified rows from BOTH halves — and excludes the quarantined", async () => {
    await seedTrack(db, { logId: "001.1.1A", trackId: "find_pending" });
    await capture("find_pending", SHA);
    await seedCatalogueTrack(db, { trackId: "cat_pending" });
    await capture("cat_pending", "b".repeat(64));

    await seedCatalogueTrack(db, { trackId: "cat_uncaptured" });

    await seedCatalogueTrack(db, { trackId: "cat_q" });
    await capture("cat_q", "c".repeat(64));
    await db.execute({
      args: [WRONG_AUDIO_STATUS, "cat_q"],
      sql: `update tracks set capture_status = ? where track_id = ?`,
    });

    const items = await listUnverifiedCaptures();
    const ids = items.map((item) => item.trackId);

    expect(ids).toContain("find_pending");
    expect(ids).toContain("cat_pending");
    expect(ids).not.toContain("cat_uncaptured");
    expect(ids).not.toContain("cat_q");

    const finding = items.find((item) => item.trackId === "find_pending");

    expect(finding?.certified).toBe(true);
    expect(finding?.logId).toBe("001.1.1A");
    expect(items.find((item) => item.trackId === "cat_pending")?.certified).toBe(false);

    expect(await countUnverifiedCaptures()).toBe(2);

    const plan = await db.execute({
      args: [WRONG_AUDIO_STATUS],
      sql: `explain query plan ${COUNT_UNVERIFIED_CAPTURES_SQL}`,
    });
    const details = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");

    expect(details).toContain("tracks_capture_verification_verified_at_idx");
  });
});
