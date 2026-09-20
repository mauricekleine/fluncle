// The operator's MINT of a label from its MusicBrainz identity, against the REAL migrated schema.
//
// It is an INTEGRATION test because every guarantee the mint makes is a statement about SQL that a
// mocked database would let through broken: the MBID fold is a UNIQUE index, the adoption is a
// fill-empty-only UPDATE, the facts are `coalesce`, and the optional ruling is the `update_label`
// write with its stamps. MusicBrainz is mocked at the shared client (there is no network), which is
// also how the counting works — the idempotent path must spend NO request.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const mbFetch = vi.hoisted(() => vi.fn());

vi.mock("./musicbrainz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./musicbrainz")>();

  return { ...actual, mbFetch };
});

import { createIntegrationDb } from "./integration-db";
import { listLabels } from "./labels";
import {
  LabelMintIdentityConflictError,
  mintLabelFromMusicbrainz,
  MusicbrainzLabelNotFoundError,
  MusicbrainzThrottledError,
} from "./label-mint";

let db: Client;

const MED_SCHOOL_MBID = "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2";
const HOSPITAL_MBID = "9f1d3c7e-2b1a-4d5f-8c6e-0a1b2c3d4e5f";

/** The default `/ws/2/label/<mbid>` body, with every field the mint reads. */
function mbLabel(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      area: { name: "London" },
      disambiguation: "UK drum & bass label",
      id: MED_SCHOOL_MBID,
      "life-span": { begin: "2008" },
      name: "Med School",
      ...overrides,
    },
    rateLimited: false,
  };
}

/** One `labels` row, read back raw so the assertions are about the stored columns. */
async function labelRow(slug: string) {
  const result = await db.execute({
    args: [slug],
    sql: `select id, name, slug, mb_label_id, disambiguation, founded_location, founding_date,
                 seed_state, ruled_at, scope_changed_at
          from labels where slug = ? limit 1`,
  });

  return result.rows[0] as
    | undefined
    | {
        disambiguation: null | string;
        founded_location: null | string;
        founding_date: null | string;
        id: string;
        mb_label_id: null | string;
        name: string;
        ruled_at: null | string;
        scope_changed_at: null | string;
        seed_state: string;
        slug: string;
      };
}

async function labelCount(): Promise<number> {
  const result = await db.execute("select count(*) as n from labels");

  return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  mbFetch.mockReset();
});

describe("mintLabelFromMusicbrainz", () => {
  it("mints a row from the MusicBrainz entity and carries its facts", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());

    const result = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    expect(result.outcome).toBe("minted");
    expect(result.label.name).toBe("Med School");
    expect(result.label.slug).toBe("med-school");
    // No ruling was asked for, so the row lands at the table's `undecided` default and enters the
    // operator's queue — a mint never silently crawls a label into the archive.
    expect(result.label.seedState).toBe("undecided");
    expect(result.label.ruledAt).toBeNull();

    const row = await labelRow("med-school");

    expect(row?.mb_label_id).toBe(MED_SCHOOL_MBID);
    expect(row?.disambiguation).toBe("UK drum & bass label");
    expect(row?.founded_location).toBe("London");
    expect(row?.founding_date).toBe("2008");
    expect(mbFetch).toHaveBeenCalledWith(`/label/${MED_SCHOOL_MBID}`);
  });

  it("is idempotent: a known MBID comes back without a second MusicBrainz request", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());
    const first = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    const second = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    expect(second.outcome).toBe("known");
    expect(second.label.id).toBe(first.label.id);
    expect(await labelCount()).toBe(1);
    // The short-circuit is the point: MusicBrainz is 1 req/s and a re-run must cost nothing.
    expect(mbFetch).toHaveBeenCalledTimes(1);
  });

  it("returns the existing row when the MBID is known under a different spelling", async () => {
    // The archive met this label as "Medschool" (a publish-path mint) and the crawler later folded
    // the MBID onto it. MusicBrainz spells it "Med School", which slugs apart — the MBID is what
    // keeps the two one row.
    await db.execute({
      args: [HOSPITAL_MBID],
      sql: `insert into labels (id, name, slug, mb_label_id, created_at, updated_at)
            values ('lbl_medschool', 'Medschool', 'medschool', ?, '2026-01-01T00:00:00.000Z',
                    '2026-01-01T00:00:00.000Z')`,
    });

    const result = await mintLabelFromMusicbrainz(HOSPITAL_MBID);

    expect(result.outcome).toBe("known");
    expect(result.label.id).toBe("lbl_medschool");
    expect(result.label.slug).toBe("medschool");
    expect(await labelCount()).toBe(1);
    expect(await labelRow("med-school")).toBeUndefined();
  });

  it("adopts the MBID onto a row that already wears the spelling, rather than duplicating", async () => {
    await db.execute(
      `insert into labels (id, name, slug, created_at, updated_at)
       values ('lbl_publish', 'Med School', 'med-school', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z')`,
    );
    mbFetch.mockResolvedValueOnce(mbLabel());

    const result = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    expect(result.outcome).toBe("adopted");
    expect(result.label.id).toBe("lbl_publish");
    expect(await labelCount()).toBe(1);

    const row = await labelRow("med-school");

    expect(row?.mb_label_id).toBe(MED_SCHOOL_MBID);
    expect(row?.founded_location).toBe("London");
  });

  it("never overwrites a fact the row already carries", async () => {
    await db.execute({
      args: [MED_SCHOOL_MBID],
      sql: `insert into labels (id, name, slug, mb_label_id, founding_date, founded_location,
                                disambiguation, created_at, updated_at)
            values ('lbl_known', 'Med School', 'med-school', ?, '1996', 'Hertfordshire',
                    'the operator wrote this', '2026-01-01T00:00:00.000Z',
                    '2026-01-01T00:00:00.000Z')`,
    });
    mbFetch.mockResolvedValueOnce(mbLabel());

    // Force the fact write by reaching the row through its SPELLING rather than the MBID
    // short-circuit: the mint asks MusicBrainz, folds onto this row, and must still fill nothing.
    await db.execute("update labels set mb_label_id = null where id = 'lbl_known'");

    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    const row = await labelRow("med-school");

    expect(row?.founding_date).toBe("1996");
    expect(row?.founded_location).toBe("Hertfordshire");
    expect(row?.disambiguation).toBe("the operator wrote this");
  });

  it("applies a supplied ruling through the seed-state write, with its stamps", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());

    const result = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled");

    expect(result.label.seedState).toBe("enabled");

    const row = await labelRow("med-school");

    expect(row?.seed_state).toBe("enabled");
    // `ruled_at` is what tells the bootstrap to keep its hands off, and `scope_changed_at` is the
    // crawl's re-arm watermark — an enable stamps both, exactly as `update_label` does.
    expect(row?.ruled_at).toEqual(expect.any(String));
    expect(row?.scope_changed_at).toEqual(expect.any(String));
    expect(result.label.ruledAt).toBe(row?.ruled_at ?? null);
  });

  it("leaves an existing ruling alone when no seed state is supplied", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());
    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled");

    const rerun = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    // A re-run must never un-rule a label: the omitted seed state is "leave it", not "undecided".
    expect(rerun.label.seedState).toBe("enabled");
    expect((await labelRow("med-school"))?.seed_state).toBe("enabled");
  });

  it("hands the crawl's seed read a slug AND a ruled identity", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());

    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled");

    // These two fields are the whole seam. Seeding reads the enabled set at the head of every tick
    // and mints a `fluncle:label:<slug>` node for each label the frontier does not hold
    // (crawl.ts `seedFromEnabledLabels`); the seed's plan then makes NO name search when the label
    // already carries `mbLabelId`, and the expansion enqueues that MBID's browse node directly. So
    // a label minted by identity is a working seed on the very next tick, and is immune by
    // construction to the namesake class the name search guards against.
    expect(await listLabels("enabled")).toEqual([
      expect.objectContaining({ mbLabelId: MED_SCHOOL_MBID, slug: "med-school" }),
    ]);
  });

  it("propagates a MusicBrainz miss as a not-found, minting nothing", async () => {
    mbFetch.mockResolvedValueOnce({ data: null, rateLimited: false });

    await expect(mintLabelFromMusicbrainz(MED_SCHOOL_MBID)).rejects.toBeInstanceOf(
      MusicbrainzLabelNotFoundError,
    );
    expect(await labelCount()).toBe(0);
  });

  it("separates an active throttle from a miss", async () => {
    mbFetch.mockResolvedValueOnce({ data: null, rateLimited: true });

    await expect(mintLabelFromMusicbrainz(MED_SCHOOL_MBID)).rejects.toBeInstanceOf(
      MusicbrainzThrottledError,
    );
    expect(await labelCount()).toBe(0);
  });

  it("refuses when the spelling already belongs to a different MusicBrainz label", async () => {
    await db.execute({
      args: [HOSPITAL_MBID],
      sql: `insert into labels (id, name, slug, mb_label_id, created_at, updated_at)
            values ('lbl_other', 'Med School', 'med-school', ?, '2026-01-01T00:00:00.000Z',
                    '2026-01-01T00:00:00.000Z')`,
    });
    mbFetch.mockResolvedValueOnce(mbLabel());

    await expect(mintLabelFromMusicbrainz(MED_SCHOOL_MBID)).rejects.toBeInstanceOf(
      LabelMintIdentityConflictError,
    );
    expect((await labelRow("med-school"))?.mb_label_id).toBe(HOSPITAL_MBID);
  });
});
