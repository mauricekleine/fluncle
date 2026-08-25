// The bio-review ledger, driven against a real in-memory libSQL engine (vitest env = node), so the
// guarantees that live in SQL are proven by SQL rather than by a mock that agrees with the code.
// `getDb` is mocked to hand back the per-test client (the artists-board.test.ts precedent).
//
// What these pin — the whole point of the slice. The entity-bio sweep's third draft LANDS even when
// the voice scan refuses it, and the acceptance carries a review flag with a reader. So:
//
//   - a BYPASSED bio raises exactly ONE row, carrying its entity and the accepted reasons;
//   - a CLEAN bio raises NONE (the false-positive case — a source that fires on good work is a
//     source the operator stops reading, which is where this started);
//   - both rulings CLEAR the row, and a later clean bio clears it too, by construction.
import { type Client, createClient } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const { BIO_REVIEW_QUEUE_LIMIT, listBioReviewRows, parseBioViolations, resolveBioReview } =
  await import("./bio-review");
const { fillEmptyArtistBio } = await import("./artists");
const { fillEmptyLabelBio } = await import("./labels");
const { fillEmptyAlbumBio } = await import("./albums");

// The three entity tables, trimmed to the bio engine's columns. `updated_at` is not null in the
// real schema and every write sets it, so the shape here keeps that honest.
const ENTITY_COLUMNS = `id text primary key, name text, slug text unique, bio text,
  bio_prompt_version integer, bio_status text, bio_gate_bypassed_at text,
  bio_voice_violations text, updated_at text`;

const GOOD_BIO = "A dry, storable paragraph about the entity, long enough to clear the bounds.";

async function seedEntity(
  db: Client,
  table: "artists" | "labels" | "albums",
  row: { id: string; name: string; slug: string },
): Promise<void> {
  await db.execute({
    args: [row.id, row.name, row.slug],
    sql: `insert into ${table} (id, name, slug, updated_at) values (?, ?, ?, '2026-07-01T00:00:00.000Z')`,
  });
}

async function readEntity(
  db: Client,
  table: "artists" | "labels" | "albums",
  slug: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({
    args: [slug],
    sql: `select bio, bio_prompt_version, bio_status, bio_gate_bypassed_at, bio_voice_violations
          from ${table} where slug = ?`,
  });

  return result.rows[0] as unknown as Record<string, unknown> | undefined;
}

describe("the bio-review ledger", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    holder.db = db;

    for (const table of ["artists", "labels", "albums"] as const) {
      await db.execute(`create table ${table} (${ENTITY_COLUMNS})`);
    }
  });

  // ── The bypass raises a row ────────────────────────────────────────────────────────────────

  it("raises exactly one row for a bio that landed past the gate, carrying the entity and the accepted reasons", async () => {
    await seedEntity(db, "artists", { id: "a1", name: "Future Signal", slug: "future-signal" });

    const filled = await fillEmptyArtistBio("future-signal", GOOD_BIO, 3, [
      "banned identity word: signal",
      "the Dry Rule: an exclamation mark",
    ]);
    expect(filled).toBe(true);

    const rows = await listBioReviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("artist");
    expect(rows[0]?.slug).toBe("future-signal");
    expect(rows[0]?.name).toBe("Future Signal");
    expect(rows[0]?.violations).toEqual([
      "banned identity word: signal",
      "the Dry Rule: an exclamation mark",
    ]);
    // The stamp is the queue's oldest-first anchor, so it has to be a real, parseable moment.
    expect(Number.isNaN(Date.parse(rows[0]?.anchorAt ?? ""))).toBe(false);

    // The bio itself landed — the bypass is a REVIEW flag, never a rejection.
    const stored = await readEntity(db, "artists", "future-signal");
    expect(stored?.bio).toBe(GOOD_BIO);
    expect(stored?.bio_status).toBe("resolved");
  });

  it("raises a row for a bypassed label and album bio too — all three kinds, one queue", async () => {
    await seedEntity(db, "labels", { id: "l1", name: "Invaderz", slug: "invaderz" });
    await seedEntity(db, "albums", { id: "b1", name: "Jungle Sound", slug: "jungle-sound" });

    await fillEmptyLabelBio("invaderz", GOOD_BIO, 0, ["banned identity word: transmission"]);
    await fillEmptyAlbumBio("jungle-sound", GOOD_BIO, 0, ["the Dry Rule: an exclamation mark"]);

    const rows = await listBioReviewRows();
    expect(rows.map((row) => row.kind).sort()).toEqual(["album", "label"]);
  });

  // ── THE FALSE-POSITIVE CASE ────────────────────────────────────────────────────────────────

  it("raises NOTHING for a bio that cleared the gate", async () => {
    await seedEntity(db, "artists", { id: "a1", name: "Calibre", slug: "calibre" });
    await seedEntity(db, "labels", { id: "l1", name: "Signature", slug: "signature" });
    await seedEntity(db, "albums", { id: "b1", name: "Second Sun", slug: "second-sun" });

    // The ordinary path: the gate passed, so no violations are handed to the write.
    await fillEmptyArtistBio("calibre", GOOD_BIO, 3);
    await fillEmptyLabelBio("signature", GOOD_BIO, 0, null);
    await fillEmptyAlbumBio("second-sun", GOOD_BIO, undefined, []);

    expect(await listBioReviewRows()).toEqual([]);

    // …and the columns are explicitly NULL rather than merely unread, which is what makes a later
    // clean bio able to clear a flag that stood.
    const stored = await readEntity(db, "artists", "calibre");
    expect(stored?.bio_gate_bypassed_at).toBeNull();
    expect(stored?.bio_voice_violations).toBeNull();
  });

  // ── The rulings clear it ───────────────────────────────────────────────────────────────────

  it("clears the row on `keep` and leaves the paragraph exactly as it stands", async () => {
    await seedEntity(db, "artists", { id: "a1", name: "Future Signal", slug: "future-signal" });
    await fillEmptyArtistBio("future-signal", GOOD_BIO, 3, ["banned identity word: signal"]);
    expect(await listBioReviewRows()).toHaveLength(1);

    expect(
      await resolveBioReview({ kind: "artist", resolution: "keep", slug: "future-signal" }),
    ).toBe(true);

    expect(await listBioReviewRows()).toEqual([]);
    const stored = await readEntity(db, "artists", "future-signal");
    expect(stored?.bio).toBe(GOOD_BIO);
    expect(stored?.bio_prompt_version).toBe(3);
    expect(stored?.bio_status).toBe("resolved");
  });

  it("clears the row on `rewrite` and empties the bio back onto the sweep's worklist", async () => {
    await seedEntity(db, "labels", { id: "l1", name: "Invaderz", slug: "invaderz" });
    await fillEmptyLabelBio("invaderz", GOOD_BIO, 2, ["banned identity word: transmission"]);
    expect(await listBioReviewRows()).toHaveLength(1);

    expect(await resolveBioReview({ kind: "label", resolution: "rewrite", slug: "invaderz" })).toBe(
      true,
    );

    expect(await listBioReviewRows()).toEqual([]);
    const stored = await readEntity(db, "labels", "invaderz");
    // Empty bio + `pending` is exactly the state the `describe --queue` worklist picks up, so the
    // entity is genuinely re-authorable rather than merely unflagged.
    expect(stored?.bio).toBeNull();
    expect(stored?.bio_prompt_version).toBeNull();
    expect(stored?.bio_status).toBe("pending");
    expect(stored?.bio_gate_bypassed_at).toBeNull();
  });

  it("re-authoring a bio that clears the gate wipes the flag in the same write", async () => {
    await seedEntity(db, "artists", { id: "a1", name: "Future Signal", slug: "future-signal" });
    await fillEmptyArtistBio("future-signal", GOOD_BIO, 3, ["banned identity word: signal"]);

    // The operator sends it back, and the next tick authors a paragraph the gate passes.
    await resolveBioReview({ kind: "artist", resolution: "rewrite", slug: "future-signal" });
    const refilled = await fillEmptyArtistBio("future-signal", `${GOOD_BIO} Rewritten.`, 4);
    expect(refilled).toBe(true);

    expect(await listBioReviewRows()).toEqual([]);
    const stored = await readEntity(db, "artists", "future-signal");
    expect(stored?.bio).toBe(`${GOOD_BIO} Rewritten.`);
    expect(stored?.bio_gate_bypassed_at).toBeNull();
    expect(stored?.bio_voice_violations).toBeNull();
  });

  it("refuses a second ruling rather than emptying a bio nobody flagged", async () => {
    await seedEntity(db, "artists", { id: "a1", name: "Calibre", slug: "calibre" });
    await fillEmptyArtistBio("calibre", GOOD_BIO, 0);

    // Never flagged: `rewrite` must not be a back door that empties any bio by slug.
    expect(await resolveBioReview({ kind: "artist", resolution: "rewrite", slug: "calibre" })).toBe(
      false,
    );
    expect((await readEntity(db, "artists", "calibre"))?.bio).toBe(GOOD_BIO);

    // Unknown slug: reported, never silently ok.
    expect(await resolveBioReview({ kind: "artist", resolution: "keep", slug: "nobody" })).toBe(
      false,
    );
  });

  it("caps each kind's arm so one source can never drown the queue", async () => {
    for (let index = 0; index < BIO_REVIEW_QUEUE_LIMIT + 5; index += 1) {
      const slug = `artist-${String(index).padStart(3, "0")}`;
      await seedEntity(db, "artists", { id: slug, name: slug, slug });
      await fillEmptyArtistBio(slug, GOOD_BIO, 0, ["banned identity word: signal"]);
    }

    expect(await listBioReviewRows()).toHaveLength(BIO_REVIEW_QUEUE_LIMIT);
  });

  // ── The evidence column degrades, never throws ─────────────────────────────────────────────

  it("still raises the row when the reasons column is corrupt", async () => {
    await seedEntity(db, "artists", { id: "a1", name: "Calibre", slug: "calibre" });
    await db.execute({
      args: [GOOD_BIO],
      sql: `update artists
              set bio = ?, bio_status = 'resolved',
                  bio_gate_bypassed_at = '2026-07-29T00:00:00.000Z',
                  bio_voice_violations = '{not json'
            where slug = 'calibre'`,
    });

    const rows = await listBioReviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.violations).toEqual([]);
  });

  it("parses the reasons column totally", () => {
    expect(parseBioViolations('["a","b"]')).toEqual(["a", "b"]);
    expect(parseBioViolations('[1, "b"]')).toEqual(["b"]);
    expect(parseBioViolations("not json")).toEqual([]);
    expect(parseBioViolations(null)).toEqual([]);
    expect(parseBioViolations("")).toEqual([]);
  });
});
