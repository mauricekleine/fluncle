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

import { createIntegrationDb, syncHubCounts } from "./integration-db";
import { listLabels } from "./labels";
import {
  LabelMintIdentityConflictError,
  LabelTakeOverNotEmptyError,
  LabelTakeOverSlugMismatchError,
  mintLabelFromMusicbrainz,
  MusicbrainzLabelNotFoundError,
  MusicbrainzThrottledError,
} from "./label-mint";

let db: Client;

const MED_SCHOOL_MBID = "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2";
const HOSPITAL_MBID = "9f1d3c7e-2b1a-4d5f-8c6e-0a1b2c3d4e5f";

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

    expect(mbFetch).toHaveBeenCalledTimes(1);
  });

  it("returns the existing row when the MBID is known under a different spelling", async () => {
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

    expect(row?.ruled_at).toEqual(expect.any(String));
    expect(row?.scope_changed_at).toEqual(expect.any(String));
    expect(result.label.ruledAt).toBe(row?.ruled_at ?? null);
  });

  it("leaves an existing ruling alone when no seed state is supplied", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());
    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled");

    const rerun = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID);

    expect(rerun.label.seedState).toBe("enabled");
    expect((await labelRow("med-school"))?.seed_state).toBe("enabled");
  });

  it("hands the crawl's seed read a slug AND a ruled identity", async () => {
    mbFetch.mockResolvedValueOnce(mbLabel());

    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled");

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

  it("names the take-over as the way through the plain conflict", async () => {
    await seedConflictingRow();
    mbFetch.mockResolvedValueOnce(mbLabel());

    await expect(mintLabelFromMusicbrainz(MED_SCHOOL_MBID)).rejects.toThrow(
      /--take-over med-school/,
    );
  });
});

async function seedConflictingRow(): Promise<void> {
  await db.execute({
    args: [HOSPITAL_MBID],
    sql: `insert into labels (id, name, slug, mb_label_id, disambiguation, founded_location,
                              founding_date, discogs_label_id, image_key, image_state,
                              parent_label_id, lineage_state, created_at, updated_at)
          values ('lbl_other', 'Med School', 'med-school', ?, 'US folk label', 'Chicago', '1974',
                  4242, 'labels/med-school.jpg', 'resolved', null, 'resolved',
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  });
}

async function seedArtistRule(labelId: string): Promise<void> {
  await db.execute({
    args: [labelId],
    sql: `insert into artist_rules (id, artist_mbid, artist_name, label_id, source, verdict,
                                    created_at, updated_at)
          values ('rule_1', '11111111-2222-3333-4444-555555555555', 'A Folk Act', ?, 'operator',
                  'allow', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  });
}

async function seedFrontierNodes(slug: string, mbLabelId: string): Promise<void> {
  await db.batch(
    [
      {
        args: [`fluncle:label:${slug}`, slug, slug],
        sql: `insert into crawl_frontier (id, kind, source, external_id, hop, label_slug, state,
                                          cursor, done_at, created_at, updated_at)
              values (?, 'label', 'fluncle', ?, 0, ?, 'done', 3, '2026-01-02T00:00:00.000Z',
                      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      },
      {
        args: [`musicbrainz:label:${mbLabelId}`, mbLabelId, slug],
        sql: `insert into crawl_frontier (id, kind, source, external_id, hop, label_slug, state,
                                          cursor, done_at, created_at, updated_at)
              values (?, 'label', 'musicbrainz', ?, 0, ?, 'done', 7, '2026-01-02T00:00:00.000Z',
                      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      },
    ],
    "write",
  );
}

async function frontierNode(id: string) {
  const result = await db.execute({
    args: [id],
    sql: `select id, state, cursor, note from crawl_frontier where id = ? limit 1`,
  });

  return result.rows[0] as
    | undefined
    | { cursor: number; id: string; note: null | string; state: string };
}

async function artistRuleCount(): Promise<number> {
  const result = await db.execute("select count(*) as n from artist_rules");

  return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
}

describe("mintLabelFromMusicbrainz --take-over", () => {
  it("re-points the named row's identity, overwrites its facts, and drops the old roster", async () => {
    await seedConflictingRow();
    await seedArtistRule("lbl_other");
    await seedFrontierNodes("med-school", HOSPITAL_MBID);
    mbFetch.mockResolvedValueOnce(mbLabel());

    const result = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled", "med-school");

    expect(result.outcome).toBe("taken_over");
    expect(result.label.id).toBe("lbl_other");

    expect(await labelCount()).toBe(1);

    const row = await labelRow("med-school");

    expect(row?.mb_label_id).toBe(MED_SCHOOL_MBID);

    expect(row?.disambiguation).toBe("UK drum & bass label");
    expect(row?.founded_location).toBe("London");
    expect(row?.founding_date).toBe("2008");

    expect(await artistRuleCount()).toBe(0);
    expect(result.takenOver).toEqual({
      clearedFacts: ["discogsLabelId", "imageKey"],
      droppedRules: 1,
      previousMbLabelId: HOSPITAL_MBID,
      rearmedSeedNode: true,
      retiredFrontierNodes: 1,
      slug: "med-school",
    });

    expect(result.label.seedState).toBe("enabled");
    expect(row?.seed_state).toBe("enabled");
    expect(row?.ruled_at).toEqual(expect.any(String));
  });

  it("clears the facts the replaced entity supplied and re-arms their sweeps", async () => {
    await seedConflictingRow();
    mbFetch.mockResolvedValueOnce(mbLabel());

    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school");

    const result = await db.execute(
      `select discogs_label_id, image_key, image_state, parent_label_id, lineage_state
       from labels where slug = 'med-school'`,
    );
    const row = result.rows[0] as undefined | Record<string, unknown>;

    expect(row?.discogs_label_id).toBeNull();
    expect(row?.image_key).toBeNull();
    expect(row?.image_state).toBe("pending");
    expect(row?.parent_label_id).toBeNull();
    expect(row?.lineage_state).toBe("pending");
  });

  it("retires the replaced entity's crawl node and re-arms the seed resolver", async () => {
    await seedConflictingRow();
    await seedFrontierNodes("med-school", HOSPITAL_MBID);
    mbFetch.mockResolvedValueOnce(mbLabel());

    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, "enabled", "med-school");

    const retired = await frontierNode(`musicbrainz:label:${HOSPITAL_MBID}`);

    expect(retired?.state).toBe("done");
    expect(retired?.note).toContain(MED_SCHOOL_MBID);

    const resolver = await frontierNode("fluncle:label:med-school");

    expect(resolver?.state).toBe("pending");
    expect(Number(resolver?.cursor)).toBe(0);
  });

  it("works for a row the frontier has never held, and says so in the result", async () => {
    await seedConflictingRow();
    mbFetch.mockResolvedValueOnce(mbLabel());

    const result = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school");

    expect(result.takenOver?.rearmedSeedNode).toBe(false);
    expect(result.takenOver?.retiredFrontierNodes).toBe(0);
    expect((await labelRow("med-school"))?.mb_label_id).toBe(MED_SCHOOL_MBID);
  });

  it("refuses a row that holds a stored track — that is a merge", async () => {
    await seedConflictingRow();
    await db.execute(
      `insert into tracks (track_id, title, artists_json, duration_ms, label_id, is_catalogue)
       values ('mb_track', 'Some Tune', '["An Act"]', 0, 'lbl_other', 1)`,
    );

    await syncHubCounts(db);
    mbFetch.mockResolvedValue(mbLabel());

    await expect(
      mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school"),
    ).rejects.toBeInstanceOf(LabelTakeOverNotEmptyError);
    await expect(
      mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school"),
    ).rejects.toThrow(/merge/);
    expect((await labelRow("med-school"))?.mb_label_id).toBe(HOSPITAL_MBID);
  });

  it("refuses a row that is a live crawl seed", async () => {
    await seedConflictingRow();
    await db.execute("update labels set seed_state = 'enabled' where id = 'lbl_other'");
    mbFetch.mockResolvedValueOnce(mbLabel());

    await expect(
      mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school"),
    ).rejects.toBeInstanceOf(LabelTakeOverNotEmptyError);
    expect((await labelRow("med-school"))?.mb_label_id).toBe(HOSPITAL_MBID);
  });

  it("refuses a slug that is not the conflicting row, and names the one that is", async () => {
    await seedConflictingRow();
    await db.execute(
      `insert into labels (id, name, slug, created_at, updated_at)
       values ('lbl_bystander', 'Bystander', 'bystander', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z')`,
    );
    mbFetch.mockResolvedValue(mbLabel());

    await expect(
      mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "bystander"),
    ).rejects.toBeInstanceOf(LabelTakeOverSlugMismatchError);
    await expect(mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "bystander")).rejects.toThrow(
      /med-school/,
    );

    expect((await labelRow("med-school"))?.mb_label_id).toBe(HOSPITAL_MBID);
    expect((await labelRow("bystander"))?.mb_label_id).toBeNull();
  });

  it("is still idempotent: a second call is `known`, take-over flag or not", async () => {
    await seedConflictingRow();
    mbFetch.mockResolvedValueOnce(mbLabel());
    await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school");

    const second = await mintLabelFromMusicbrainz(MED_SCHOOL_MBID, undefined, "med-school");

    expect(second.outcome).toBe("known");
    expect(second.takenOver).toBeUndefined();

    expect(mbFetch).toHaveBeenCalledTimes(1);
    expect(await labelCount()).toBe(1);
  });
});
