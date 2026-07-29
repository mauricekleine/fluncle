// The label entity's two ruling-time halves, proven against the REAL migrated schema on an
// in-memory libSQL engine: the logo's place on the owned-cover ladder, and the identity the
// `/admin/labels` station reads while the operator rules.
//
// It is an INTEGRATION test because both halves are SQL, and a mocked-DB test would pass while
// either was broken:
//
//   - the migration itself (`labels.image_updated_at` + `labels.disambiguation`) — if it did not
//     apply, every statement below referencing those columns would throw here, which is exactly
//     the guard we want, since `deploy:gate` runs this suite;
//   - the resolve sweep's success WRITE — the `?v` bust is only real if `image_updated_at` is
//     actually stamped by the same UPDATE that stores the key, and the served URL moves with it;
//   - `listLabelsPage`'s projection — the four identity columns have to survive the round trip
//     from the `labels` row to the `LabelAdminItem` the station renders.
//
// The vendors are mocked (there is no network): MusicBrainz answers "no match", Discogs hands back
// one logo, and R2 is a fake bucket that records its `put`s.

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

const fetchDiscogsLabelImage = vi.hoisted(() => vi.fn());

vi.mock("./discogs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discogs")>();

  return { ...actual, fetchDiscogsLabelImage };
});

const readOptionalEnv = vi.hoisted(() => vi.fn());

vi.mock("./env", () => ({ readOptionalEnv }));

import { createIntegrationDb } from "./integration-db";
import { resolveLabelImages } from "./label-images";
import { listLabelsPage } from "./labels";

let db: Client;

/** A fake world-served R2 that records its `put`s instead of storing anything. */
function fakeBucket(): { bucket: Pick<R2Bucket, "put">; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn(
    (_key: string, _value: ArrayBuffer | string, _options?: unknown): Promise<undefined> =>
      Promise.resolve(undefined),
  );

  return { bucket: { put } as unknown as Pick<R2Bucket, "put">, put };
}

/** One `labels` row with whatever identity the test wants it to carry. */
async function seedLabel(opts: {
  disambiguation?: string;
  discogsLabelId?: number;
  foundedLocation?: string;
  foundingDate?: string;
  mbLabelId?: string;
  name: string;
  slug: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [
      `lbl_${opts.slug}`,
      opts.name,
      opts.slug,
      opts.mbLabelId ?? null,
      opts.disambiguation ?? null,
      opts.foundingDate ?? null,
      opts.foundedLocation ?? null,
      opts.discogsLabelId ?? null,
      now,
      now,
    ],
    sql: `insert into labels
            (id, name, slug, mb_label_id, disambiguation, founding_date, founded_location,
             discogs_label_id, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, 'undecided', ?, ?)`,
  });
}

async function labelColumn(slug: string, column: string): Promise<unknown> {
  const result = await db.execute({
    args: [slug],
    sql: `select ${column} as value from labels where slug = ?`,
  });

  return (result.rows[0] as Record<string, unknown> | undefined)?.["value"];
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  mbFetch.mockReset();
  // MusicBrainz finds no matching label, so the sweep falls straight to the stored Discogs id.
  mbFetch.mockResolvedValue({ data: { labels: [] }, rateLimited: false });

  fetchDiscogsLabelImage.mockReset();
  readOptionalEnv.mockReset();
  readOptionalEnv.mockResolvedValue("discogs-token");
});

describe("the labels migration", () => {
  it("applies both new columns to the real schema", async () => {
    const result = await db.execute(`pragma table_info(labels)`);
    const columns = result.rows.map((row) => String((row as Record<string, unknown>)["name"]));

    expect(columns).toContain("image_updated_at");
    expect(columns).toContain("disambiguation");
  });

  it("leaves both nullable with no default, so no existing row is rewritten", async () => {
    const result = await db.execute(`pragma table_info(labels)`);
    const rows = result.rows as unknown as Array<Record<string, unknown>>;
    const added = rows.filter((row) =>
      ["disambiguation", "image_updated_at"].includes(String(row["name"])),
    );

    expect(added).toHaveLength(2);

    for (const column of added) {
      expect(Number(column["notnull"])).toBe(0);
      expect(column["dflt_value"]).toBeNull();
    }
  });
});

describe("the label-images resolve sweep stamps the serving vintage", () => {
  it("writes image_updated_at alongside the key, and the served URL carries it as ?v", async () => {
    await seedLabel({ discogsLabelId: 4242, name: "Hospital Records", slug: "hospital-records" });
    fetchDiscogsLabelImage.mockResolvedValue({
      image: { bytes: new ArrayBuffer(8), mime: "image/jpeg" },
      rateLimited: false,
    });

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 5, false);

    expect(result.resolved).toEqual(["hospital-records"]);
    expect(put.mock.calls[0]?.[0]).toBe("labels/hospital-records.jpg");

    const imageKey = await labelColumn("hospital-records", "image_key");
    const vintage = await labelColumn("hospital-records", "image_updated_at");

    expect(imageKey).toBe("labels/hospital-records.jpg");
    expect(typeof vintage).toBe("string");

    // The vintage is not bookkeeping: it IS the bust on the URL the station serves.
    const page = await listLabelsPage("undecided", 1);
    const served = page.items[0]?.logoImageUrl;

    expect(served).toContain("/cdn-cgi/image/width=640,format=auto/");
    expect(served).toContain("labels/hospital-records.jpg");
    expect(served).toContain(`?v=${Date.parse(String(vintage))}`);
  });

  it("re-keys every rendition when a replaced logo bumps the vintage", async () => {
    await seedLabel({ discogsLabelId: 4242, name: "Hospital Records", slug: "hospital-records" });
    fetchDiscogsLabelImage.mockResolvedValue({
      image: { bytes: new ArrayBuffer(8), mime: "image/jpeg" },
      rateLimited: false,
    });

    const { bucket } = fakeBucket();

    await resolveLabelImages(bucket, 5, false);

    const before = (await listLabelsPage("undecided", 1)).items[0]?.logoImageUrl;

    // A second resolve at the SAME key (a replaced logo) — only the vintage moves.
    await db.execute({
      args: ["2030-01-01T00:00:00.000Z", "hospital-records"],
      sql: `update labels set image_updated_at = ?, image_state = 'pending' where slug = ?`,
    });

    const after = (await listLabelsPage("undecided", 1)).items[0]?.logoImageUrl;

    expect(before).toBeDefined();
    expect(after).not.toBe(before);
    expect(after).toContain(`?v=${Date.parse("2030-01-01T00:00:00.000Z")}`);
  });

  it("still serves a logo resolved before the vintage column existed", async () => {
    await seedLabel({ name: "Metalheadz", slug: "metalheadz" });
    await db.execute({
      args: ["metalheadz"],
      sql: `update labels
            set image_key = 'labels/metalheadz.png', image_state = 'resolved',
                image_updated_at = null
            where slug = ?`,
    });

    const served = (await listLabelsPage("undecided", 1)).items[0]?.logoImageUrl;

    expect(served).toContain("labels/metalheadz.png?v=1");
  });
});

describe("listLabelsPage carries the ruling-time identity", () => {
  it("returns the MBID, the disambiguation, and the founding pair", async () => {
    await seedLabel({
      disambiguation: "UK drum & bass label",
      foundedLocation: "London",
      foundingDate: "1996-04-29",
      mbLabelId: "0d4e2b8f-1111-2222-3333-444455556666",
      name: "Hospital Records",
      slug: "hospital-records",
    });

    const item = (await listLabelsPage("undecided", 1)).items[0];

    expect(item?.mbLabelId).toBe("0d4e2b8f-1111-2222-3333-444455556666");
    expect(item?.disambiguation).toBe("UK drum & bass label");
    expect(item?.foundingDate).toBe("1996-04-29");
    expect(item?.foundedLocation).toBe("London");
  });

  // Most labels legitimately carry none of it — MusicBrainz only disambiguates a name that
  // needed it. Those come back as nulls, and the station renders no identity line at all.
  it("returns nulls for a label MusicBrainz never had to disambiguate", async () => {
    await seedLabel({ name: "A Brand New Imprint", slug: "a-brand-new-imprint" });

    const item = (await listLabelsPage("undecided", 1)).items[0];

    expect(item?.mbLabelId).toBeNull();
    expect(item?.disambiguation).toBeNull();
    expect(item?.foundingDate).toBeNull();
    expect(item?.foundedLocation).toBeNull();
    expect(item?.logoImageUrl).toBeUndefined();
  });
});
