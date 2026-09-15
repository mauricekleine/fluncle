import { type Client, type InArgs } from "@libsql/client";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// THE LABEL TILE COVER, against the real migrated schema.
//
// A label borrows its cover from one of its tracks: the freshest release with cover art (an
// undated release last), ties broken by the lower track id, carrying that track's album master
// columns. The pick orders the label's tracks alone and reads the one winning cover by primary key.
// These tests pin that it returns exactly the row the single ordered join (the reference below)
// returns, for every label shape and through every public read that carries it, and that its plan
// orders a label's tracks with no album seek inside that ordered read.

let db: Client;
let execute: MockInstance<Client["execute"]>;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so the module's `getDb` reads the fixture database.
const {
  LABEL_CATALOGUE_COVER_JSON,
  coverFromJson,
  getLabelDetail,
  listLabelsApiPage,
  listLabelsHubPage,
} = await import("./labels");

/** The single ordered join the pick must agree with: the label's tracks ordered with their albums
    joined, first row kept. */
const REFERENCE_COVER_JSON = `(select json_object('u', t2.album_image_url, 'k', a2.image_key,
                              's', a2.image_state, 'v', a2.image_updated_at)
             from tracks t2
             left join albums a2 on a2.id = t2.album_id
            where t2.label_id = labels.id and t2.album_image_url is not null
            order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
            limit 1)`;

const NOW = "2026-07-01T00:00:00.000Z";

type SeedAlbum = { id: string; key: null | string; state: string; updatedAt: null | string };
type SeedLabel = { id: string; slug: string };
type SeedTrack = {
  albumId: null | string;
  art: null | string;
  labelId: null | string;
  releaseDate: null | string;
  trackId: string;
};

const ALBUMS: SeedAlbum[] = [
  { id: "al-owned", key: "albums/al-owned.jpg", state: "resolved", updatedAt: NOW },
  { id: "al-owned-2", key: "albums/al-owned-2.png", state: "resolved", updatedAt: null },
  { id: "al-pending", key: "albums/al-pending.jpg", state: "pending", updatedAt: null },
  { id: "al-none", key: null, state: "none", updatedAt: null },
];
/** Album ids a track may point at: real rows, no album, and an id with no album row. */
const ALBUM_POOL = ["al-owned", "al-owned-2", "al-pending", "al-none", null, "al-dangling"];

/** A deterministic PRNG, so the generated world is identical on every run. */
function mulberry32(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function art(trackId: string): string {
  return `https://covers.example/${trackId}.jpg`;
}

/**
 * The hand-built label shapes plus a generated tie-heavy world. Track ids, insertion order, and
 * release order all disagree, so an order that dropped a term would pick a different row.
 */
function world(): { labels: SeedLabel[]; tracks: SeedTrack[] } {
  const labels: SeedLabel[] = [];
  const tracks: SeedTrack[] = [];
  const label = (slug: string): string => {
    const id = `lbl-${slug}`;
    labels.push({ id, slug });

    return id;
  };

  // A label with 1,200 tracks over a few dates, a tenth undated, some without art: the freshest
  // date is shared by several tracks, and the lowest track id on it has no art.
  const big = label("big-imprint");
  for (let index = 0; index < 1200; index += 1) {
    const trackId = `big-${String((index * 7919) % 10_007).padStart(5, "0")}`;
    tracks.push({
      albumId: ALBUM_POOL[index % ALBUM_POOL.length] ?? null,
      art: index % 7 === 3 ? null : art(trackId),
      labelId: big,
      releaseDate: index % 10 === 9 ? null : `202${index % 5}-0${(index % 3) + 1}-15`,
      trackId,
    });
  }
  tracks.push(
    { albumId: "al-owned", art: null, labelId: big, releaseDate: "2024-03-15", trackId: "big-0" },
    { albumId: "al-none", art: art("big-z"), labelId: big, releaseDate: null, trackId: "big-z" },
  );

  // Equal release dates, inserted in descending id order: the lowest id wins.
  const tie = label("tie-break");
  for (const trackId of ["tie-d", "tie-c", "tie-b", "tie-a"]) {
    tracks.push({
      albumId: trackId === "tie-a" ? "al-pending" : "al-owned",
      art: art(trackId),
      labelId: tie,
      releaseDate: "2025-05-05",
      trackId,
    });
  }

  // Every release undated: the lowest id with art wins.
  const undated = label("undated-only");
  for (const trackId of ["und-3", "und-1", "und-2"]) {
    tracks.push({ albumId: null, art: art(trackId), labelId: undated, releaseDate: null, trackId });
  }

  // Tracks, but none with art: no cover.
  const noArt = label("no-art");
  for (const trackId of ["noart-1", "noart-2", "noart-3"]) {
    tracks.push({ albumId: "al-owned", art: null, labelId: noArt, releaseDate: NOW, trackId });
  }

  // No tracks at all (the stored counter still clears the floor): no cover.
  label("no-tracks");

  // The freshest release has no art, so the older one with art wins.
  const uncovered = label("fresh-uncovered");
  tracks.push(
    {
      albumId: "al-owned",
      art: null,
      labelId: uncovered,
      releaseDate: "2026-01-01",
      trackId: "fu-1",
    },
    {
      albumId: "al-owned-2",
      art: art("fu-2"),
      labelId: uncovered,
      releaseDate: "2020-01-01",
      trackId: "fu-2",
    },
    {
      albumId: "al-owned",
      art: art("fu-3"),
      labelId: uncovered,
      releaseDate: "2019-01-01",
      trackId: "fu-3",
    },
  );

  // Mixed date precision orders as text: the day beats the month beats the year.
  const precision = label("date-precision");
  tracks.push(
    {
      albumId: "al-none",
      art: art("dp-1"),
      labelId: precision,
      releaseDate: "2024",
      trackId: "dp-1",
    },
    {
      albumId: "al-owned",
      art: art("dp-2"),
      labelId: precision,
      releaseDate: "2024-06",
      trackId: "dp-2",
    },
    {
      albumId: "al-pending",
      art: art("dp-3"),
      labelId: precision,
      releaseDate: "2024-06-01",
      trackId: "dp-3",
    },
  );

  // The winner has no album row, or points at an album id with no row: raw art, null master.
  const albumless = label("album-less");
  tracks.push(
    {
      albumId: null,
      art: art("alb-1"),
      labelId: albumless,
      releaseDate: "2023-02-02",
      trackId: "alb-1",
    },
    {
      albumId: "al-dangling",
      art: art("alb-0"),
      labelId: albumless,
      releaseDate: "2023-02-02",
      trackId: "alb-0",
    },
  );

  // Fresher tracks on no label: they must never leak into any label's pick.
  tracks.push({
    albumId: "al-owned",
    art: art("orphan-1"),
    labelId: null,
    releaseDate: "2099-01-01",
    trackId: "a-orphan",
  });

  // A generated world: 45 labels over only six dates plus undated, so ties are the common case.
  const random = mulberry32(0x1abe1);
  const dates = ["2021-01-01", "2021-06-30", "2022-12-31", "2023", "2023-07", "2024-02-29", null];
  for (let labelIndex = 0; labelIndex < 45; labelIndex += 1) {
    const labelId = label(`gen-${String((labelIndex * 17) % 45).padStart(2, "0")}-label`);
    const size = Math.floor(random() * 60);
    for (let index = 0; index < size; index += 1) {
      const trackId = `g${labelIndex}-${Math.floor(random() * 1_000_000).toString(36)}-${index}`;
      tracks.push({
        albumId: ALBUM_POOL[Math.floor(random() * ALBUM_POOL.length)] ?? null,
        art: random() < 0.2 ? null : art(trackId),
        labelId,
        releaseDate: dates[Math.floor(random() * dates.length)] ?? null,
        trackId,
      });
    }
  }

  return { labels, tracks };
}

async function seed(labels: SeedLabel[], tracks: SeedTrack[]): Promise<void> {
  await db.batch(
    [
      ...ALBUMS.map((album) => ({
        args: [
          album.id,
          `Album ${album.id}`,
          album.id,
          NOW,
          NOW,
          album.key,
          album.state,
          album.updatedAt,
        ],
        sql: `insert into albums (id, name, slug, created_at, updated_at, image_key, image_state, image_updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?)`,
      })),
      ...labels.map((row) => ({
        args: [row.id, `Label ${row.slug}`, row.slug, NOW, NOW],
        sql: `insert into labels
                (id, name, slug, created_at, updated_at, renderable_track_count, certified_finding_count)
              values (?, ?, ?, ?, ?, 3, 0)`,
      })),
      ...tracks.map((row) => ({
        args: [
          row.trackId,
          `Title ${row.trackId}`,
          row.albumId,
          row.labelId,
          row.art,
          row.releaseDate,
        ],
        sql: `insert into tracks
                (track_id, title, artists_json, duration_ms, album_id, label_id, album_image_url, release_date)
              values (?, ?, '["Artist"]', 270000, ?, ?, ?, ?)`,
      })),
    ],
    "write",
  );
}

/** The cover rule, computed in TypeScript with no SQL: the picked track id per label. */
function expectedPick(labelId: string, tracks: SeedTrack[]): string | undefined {
  return tracks
    .filter((track) => track.labelId === labelId && track.art !== null)
    .sort((left, right) => {
      if ((left.releaseDate === null) !== (right.releaseDate === null)) {
        return left.releaseDate === null ? 1 : -1;
      }

      if (left.releaseDate !== right.releaseDate) {
        return (left.releaseDate ?? "") < (right.releaseDate ?? "") ? 1 : -1;
      }

      return left.trackId < right.trackId ? -1 : 1;
    })[0]?.trackId;
}

async function coverColumns(expression: string): Promise<Map<string, null | string>> {
  const result = await db.execute(
    `select labels.slug as slug, ${expression} as cover_json from labels`,
  );

  return new Map(
    result.rows.map((row) => [
      typeof row.slug === "string" ? row.slug : "",
      typeof row.cover_json === "string" ? row.cover_json : null,
    ]),
  );
}

/** The SQL and bound args of one executed statement, whichever call shape it used. */
function asStatement(value: unknown): { args: InArgs; sql: string } | undefined {
  if (typeof value === "string") {
    return { args: [], sql: value };
  }

  if (typeof value !== "object" || value === null || !("sql" in value)) {
    return undefined;
  }

  const { args, sql } = value as { args?: InArgs; sql: unknown };

  return typeof sql === "string" ? { args: args ?? [], sql } : undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute = vi.spyOn(db, "execute");
});

describe("the label tile cover pick", () => {
  it("returns the ordered join's cover JSON for every label, and the rule's track", async () => {
    const { labels, tracks } = world();
    await seed(labels, tracks);

    const picked = await coverColumns(LABEL_CATALOGUE_COVER_JSON);
    const reference = await coverColumns(REFERENCE_COVER_JSON);
    const albums = new Map(ALBUMS.map((album) => [album.id, album]));

    expect(picked.size).toBe(labels.length);
    expect(picked).toEqual(reference);

    for (const label of labels) {
      const trackId = expectedPick(label.id, tracks);
      const raw = picked.get(label.slug);

      if (trackId === undefined) {
        expect(raw, label.slug).toBeNull();
        continue;
      }

      const track = tracks.find((row) => row.trackId === trackId);
      const album = track?.albumId ? albums.get(track.albumId) : undefined;

      expect(JSON.parse(raw ?? "null"), label.slug).toEqual({
        k: album?.key ?? null,
        s: album?.state ?? null,
        u: art(trackId),
        v: album?.updatedAt ?? null,
      });
    }

    expect(expectedPick("lbl-tie-break", tracks)).toBe("tie-a");
    expect(expectedPick("lbl-undated-only", tracks)).toBe("und-1");
    expect(expectedPick("lbl-fresh-uncovered", tracks)).toBe("fu-2");
    expect(expectedPick("lbl-date-precision", tracks)).toBe("dp-3");
    expect(expectedPick("lbl-album-less", tracks)).toBe("alb-0");
    expect(picked.get("no-art")).toBeNull();
    expect(picked.get("no-tracks")).toBeNull();
  });

  it("serves the reference cover through the hub page, the list API, and the label detail", async () => {
    const { labels, tracks } = world();
    await seed(labels, tracks);

    const reference = await coverColumns(REFERENCE_COVER_JSON);
    const expected = (slug: string) => coverFromJson(reference.get(slug) ?? null);

    const hub = [...(await listLabelsHubPage(1)).items, ...(await listLabelsHubPage(2)).items];
    const api = [...(await listLabelsApiPage(1)).items, ...(await listLabelsApiPage(2)).items];

    expect(hub.map((item) => item.slug).sort()).toEqual(labels.map((label) => label.slug).sort());
    expect(api).toHaveLength(labels.length);

    for (const item of [...hub, ...api]) {
      expect(item.coverImageUrl, item.slug).toBe(expected(item.slug));
    }

    for (const label of labels) {
      expect((await getLabelDetail(label.slug))?.coverImageUrl, label.slug).toBe(
        expected(label.slug),
      );
    }

    // A resolved album master wins over the raw art and an unresolved one does not, so both
    // provider paths are exercised.
    expect(expected("tie-break")).toBe(art("tie-a"));
    expect(expected("fresh-uncovered")).toContain("albums/al-owned-2.png");
    expect(expected("undated-only")).toBe(art("und-1"));
    expect(expected("no-tracks")).toBeUndefined();
  });

  it("orders a label's tracks with no album seek, then reads the one cover by primary key", async () => {
    const { labels, tracks } = world();
    await seed(labels, tracks);
    execute.mockClear();

    await listLabelsHubPage(1);

    const tile = execute.mock.calls
      .map((call) => asStatement(call[0]))
      .find((statement) => statement?.sql.includes("json_object('u'"));

    expect(tile).toBeDefined();

    if (tile === undefined) {
      return;
    }

    const plan = await db.execute({ args: tile.args, sql: `explain query plan ${tile.sql}` });
    const nodes = plan.rows.map((row) => ({
      detail: typeof row.detail === "string" ? row.detail : "",
      id: Number(row.id),
      parent: Number(row.parent),
    }));
    const sorts = nodes.filter((node) => node.detail === "USE TEMP B-TREE FOR ORDER BY");

    expect(sorts).toHaveLength(1);

    const pickScope = sorts[0]?.parent;
    const inPick = nodes.filter((node) => node.parent === pickScope).map((node) => node.detail);
    const coverScope = nodes.find((node) => node.id === pickScope)?.parent;
    const inCover = nodes.filter((node) => node.parent === coverScope).map((node) => node.detail);

    expect(inPick).toContainEqual(
      expect.stringMatching(/^SEARCH t2 USING INDEX tracks_label_id_idx \(label_id=\?\)$/),
    );
    expect(inPick.filter((detail) => /\ba2\b|albums/.test(detail))).toEqual([]);
    expect(inCover).toContainEqual(
      expect.stringMatching(/^SEARCH c USING INDEX \S+ \(track_id=\?\)$/),
    );
    expect(inCover).toContainEqual(
      expect.stringMatching(/^SEARCH a2 USING INDEX \S+ \(id=\?\) LEFT-JOIN$/),
    );
  });
});
