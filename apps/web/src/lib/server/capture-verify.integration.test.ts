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

// THE CAPTURE-VERIFICATION ROUTING, PROVEN — against the real schema (docs/the-ear.md § Wrong
// audio). The box's verify-captures sweep only ever reports a plain verdict; everything that
// MATTERS — who gets quarantined, who only gets flagged, what enters the bad-audio memory, and
// what leaves the worklist — is decided here in `verifyCapture`, so it is proven here, on a real
// libSQL engine built from the generated migrations.
//
// The line these cases hold: a MISMATCH on a CATALOGUE row is rewound by the machine (nothing
// public was said about it), while a MISMATCH on a FINDING is only STAMPED — the operator's
// attention queue picks it up and HE rules with flag_wrong_audio. A machine never rewinds a
// public finding.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

/** Store a capture on a row, the way the capture sweep's write-back leaves it. */
async function capture(trackId: string, sha: string): Promise<void> {
  await db.execute({
    args: [`catalogue/${trackId}/${sha}.webm`, trackId],
    sql: `update tracks set source_audio_key = ?, capture_status = 'done',
          source_audio_captured_at = '2026-07-01T00:00:00.000Z' where track_id = ?`,
  });
}

/** Give a row a (stand-in) vector, so a quarantine has something real to drop. */
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
    // LEFT JOIN the satellite: a quarantined row has no `track_embeddings` row at all, so the
    // null this reports IS "the poisoned vector is gone".
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
    // Idempotence's other half: a stamped row leaves the backfill's worklist.
    expect((await listUnverifiedCaptures()).map((item) => item.trackId)).not.toContain("cat_ok");
  });

  it("stamps NO-PREVIEW `unverified` — the honest abstain, never a block", async () => {
    await seedCatalogueTrack(db, { trackId: "cat_nopreview" });
    await capture("cat_nopreview", SHA);

    expect(await verifyCapture("cat_nopreview", "no-preview")).toBe("unverified");
    expect((await readRow("cat_nopreview")).capture_verification).toBe("unverified");
  });

  it("QUARANTINES a catalogue MISMATCH: rewound, sha remembered, back in the capture queue", async () => {
    // A captured row was AUTHORIZED when it was bought (RFC artist-primary-capture, slice 1); seed
    // it on an enabled label so the re-derived pre-audio tier keeps it in the capture queue.
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

    // The wrong-audio rewind: status flipped, the poisoned vector dropped, the pre-audio tier
    // re-derived (its enabled label lands tier 1 — back on the capture ladder for a fresh download).
    expect(row.capture_status).toBe(WRONG_AUDIO_STATUS);
    expect(row.embedding_blob).toBeNull();
    expect(row.capture_priority).toBe(1);
    // The verdict IS kept on the quarantined row — the lens's honest WHY (a preview mismatch, not
    // an archive collision); the fresh capture's ingest gate overwrites it when the re-download lands.
    expect(row.capture_verification).toBe("mismatch");
    // The REJECTION MEMORY: the bad bytes' sha entered `source_audio_rejected`, so the re-capture's
    // pre-download/backstop filters refuse the same master.
    const rejected = JSON.parse(row.source_audio_rejected ?? "[]") as { sha256: string }[];

    expect(rejected.map((entry) => entry.sha256)).toContain(SHA);
  });

  it("only STAMPS a finding MISMATCH — a machine never rewinds a public finding", async () => {
    await seedTrack(db, { logId: "005.9.9L", trackId: "find_wrong" });
    await capture("find_wrong", SHA);
    await embed("find_wrong");

    expect(await verifyCapture("find_wrong", "mismatch")).toBe("flagged-finding");

    const row = await readRow("find_wrong");

    // The suspicion is recorded (this is what the capture-suspect attention read keys on)…
    expect(row.capture_verification).toBe("mismatch");
    // …and NOTHING is rewound: the status, the vector, and the memory are untouched until the
    // operator rules with flag_wrong_audio.
    expect(row.capture_status).toBe("done");
    expect(row.embedding_blob).not.toBeNull();
    expect(row.source_audio_rejected).toBeNull();
  });

  it("RE-CHECKS a CONSENSUS-VERIFIED capture like any other — machine evidence gets no pass", async () => {
    // The ladder's consensus (docs/the-ear.md § Wrong audio) is machine evidence, subordinate to a
    // preview match and to the operator's pin: a verdict posted for it routes exactly as it would
    // for a `preview-match` row. A mismatch on a FINDING is stamped and raised for the operator; a
    // fresh match re-stamps the row. It sits off the unverified worklist only because its
    // verification is non-null, like every stamped row.
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
    // The capture-source pin (docs/the-ear.md § Wrong audio): the sweep stamps a pinned capture
    // `operator-verified`, which keeps it off the unverified worklist by construction; this is the
    // server backstop for a box re-posting a verdict it measured before the pin landed. Proven on
    // BOTH halves, with the harshest verdict: the finding is not flagged, the catalogue row is not
    // rewound, and neither stamp moves.
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
    // …and the worklist never offered either row in the first place.
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
    // Not captured → not listable.
    await seedCatalogueTrack(db, { trackId: "cat_uncaptured" });
    // Quarantined → excluded (its bytes are pending a fresh capture the gate will verify).
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

    // The opt-in gauge executes against the generated schema and counts the exact same worklist.
    expect(await countUnverifiedCaptures()).toBe(2);

    const plan = await db.execute({
      args: [WRONG_AUDIO_STATUS],
      sql: `explain query plan ${COUNT_UNVERIFIED_CAPTURES_SQL}`,
    });
    const details = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");

    // The leading `capture_verification is null` seek must stay on the documented btree; adding a
    // gauge is acceptable here precisely because it does not scan the growing tracks table.
    expect(details).toContain("tracks_capture_verification_verified_at_idx");
  });
});
