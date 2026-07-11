// The public LAUNCH GATE (browse-by-feel RFC, decision 5) against a real in-memory
// libSQL engine — the load-bearing guarantee: a PARTIAL map (any non-retired galaxy
// still unnamed) renders NOTHING public, and every public read lights up together the
// moment the last name lands. `getDb` is mocked to the per-test client; `./tracks` is
// stubbed so the gate logic is tested without hydrating the full tracks schema (the
// adjacency ranking still runs for real over the seeded centroids).
import { type Client, createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

// Stub the tracks hydration: the gate/adjacency logic is what's under test, not the
// finding SELECT. `getFindingsByGalaxyRanked` echoes a cover per call so the panes'
// cover mapping is exercised; `toPublicTrackListItem` is identity.
vi.mock("./tracks", () => ({
  getFindingsByGalaxyRanked: vi.fn(async (galaxyId: string) => [
    { albumImageUrl: `cover-${galaxyId}`, logId: `L-${galaxyId}`, trackId: `t-${galaxyId}` },
  ]),
  toPublicTrackListItem: <T>(item: T) => item,
}));

import {
  getGalaxyLensPage,
  getPublicGalaxyBySlug,
  GalaxyNotFoundError,
  isGalaxyMapFullyNamed,
  listGalaxyPanes,
  listPublicGalaxies,
} from "./galaxies-map";

type SeedGalaxy = {
  centroid?: number[];
  id: string;
  name?: string | null;
  retiredAt?: string | null;
  slug?: string | null;
};

async function seedGalaxy(db: Client, g: SeedGalaxy): Promise<void> {
  await db.execute({
    args: [
      g.id,
      `handle-${g.id}`,
      g.name ?? null,
      g.slug ?? null,
      JSON.stringify(g.centroid ?? [1, 0]),
      g.retiredAt ?? null,
    ],
    sql: `insert into galaxies (id, handle, name, slug, centroid_json, retired_at, split_requested_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, null, 't0', 't0')`,
  });
}

// Give a galaxy `count` members (so memberCounts + the pane/adjacency counts are real).
async function seedMembers(db: Client, galaxyId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await db.execute({
      args: [`${galaxyId}-t${i}`, galaxyId],
      // A galaxy MEMBER is a finding — `galaxy_id` is the certification's, so the
      // member row lives in `findings` (a catalogue track has no galaxy).
      sql: `insert into findings (track_id, galaxy_id, added_at) values (?, ?, '2026-07-01')`,
    });
  }
}

describe("the galaxy launch gate", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    holder.db = db;

    await db.execute(
      `create table galaxies (id text primary key, handle text, name text, slug text,
        centroid_json text, retired_at text, split_requested_at text, created_at text, updated_at text)`,
    );
    // The tracks/findings pair, minimal: the galaxy lens counts + ranks MEMBERS, and a
    // member is a certified finding — so `galaxy_id` sits on `findings`, keyed 1:1 to the
    // `tracks` row it certifies (docs/track-lifecycle.md).
    await db.execute(`create table tracks (track_id text primary key)`);
    await db.execute(
      `create table findings (track_id text primary key, galaxy_id text, added_at text,
        log_id text)`,
    );
  });

  it("an EMPTY map is not fully named — every public read is dark", async () => {
    expect(await isGalaxyMapFullyNamed()).toBe(false);
    expect(await listPublicGalaxies()).toEqual([]);
    expect(await listGalaxyPanes(4)).toEqual([]);
    expect(await getGalaxyLensPage("anything", 24, 0)).toBeNull();
  });

  it("a PARTIAL map (one named, one unnamed) renders NOTHING public — the load-bearing gate", async () => {
    await seedGalaxy(db, { id: "gA", name: "The Liquid Deep", slug: "the-liquid-deep" });
    await seedGalaxy(db, { id: "gB", name: null, slug: null }); // unnamed → map is partial
    await seedMembers(db, "gA", 5);

    expect(await isGalaxyMapFullyNamed()).toBe(false);
    // The named galaxy exists, but NOT ONE public surface reveals it while the map is partial:
    expect(await listPublicGalaxies()).toEqual([]);
    expect(await listGalaxyPanes(4)).toEqual([]);
    expect(await getGalaxyLensPage("the-liquid-deep", 24, 0)).toBeNull();
    await expect(getPublicGalaxyBySlug("the-liquid-deep", 24, 0)).rejects.toBeInstanceOf(
      GalaxyNotFoundError,
    );
  });

  it("a FULLY named map lights every public read up together", async () => {
    await seedGalaxy(db, {
      centroid: [1, 0],
      id: "gA",
      name: "The Liquid Deep",
      slug: "the-liquid-deep",
    });
    await seedGalaxy(db, {
      centroid: [0.9, 0.1],
      id: "gB",
      name: "Weightless Rollers",
      slug: "weightless-rollers",
    });
    await seedGalaxy(db, {
      centroid: [0, 1],
      id: "gC",
      name: "The Feral Steppers",
      slug: "the-feral-steppers",
    });
    await seedMembers(db, "gA", 6);
    await seedMembers(db, "gB", 3);
    await seedMembers(db, "gC", 1);

    expect(await isGalaxyMapFullyNamed()).toBe(true);

    // list_galaxies — count-descending, name tie-break; all three present.
    const listed = await listPublicGalaxies();
    expect(listed.map((g) => g.slug)).toEqual([
      "the-liquid-deep", // 6 members
      "weightless-rollers", // 3
      "the-feral-steppers", // 1
    ]);
    expect(listed[0]?.memberCount).toBe(6);

    // The index panes carry the derived count + a core-first cover sample.
    const panes = await listGalaxyPanes(4);
    expect(panes.map((p) => p.slug)).toContain("the-liquid-deep");
    expect(panes.find((p) => p.slug === "the-liquid-deep")?.covers).toEqual(["cover-gA"]);

    // The lens page resolves and ranks adjacency by centroid cosine: gB (0.9,0.1) is
    // nearer gA (1,0) than gC (0,1), so it leads the "Close in sound" strip.
    const page = await getGalaxyLensPage("the-liquid-deep", 24, 0);
    expect(page?.galaxy.slug).toBe("the-liquid-deep");
    expect(page?.adjacent.map((a) => a.slug)).toEqual(["weightless-rollers", "the-feral-steppers"]);

    // The public by-slug read resolves too; an unknown slug still 404s.
    await expect(getPublicGalaxyBySlug("the-liquid-deep", 24, 0)).resolves.toMatchObject({
      galaxy: { slug: "the-liquid-deep" },
    });
    await expect(getPublicGalaxyBySlug("no-such-galaxy", 24, 0)).rejects.toBeInstanceOf(
      GalaxyNotFoundError,
    );
  });

  it("a RETIRED unnamed galaxy never blocks the launch (excluded from the gate)", async () => {
    await seedGalaxy(db, { id: "gA", name: "The Liquid Deep", slug: "the-liquid-deep" });
    await seedGalaxy(db, { id: "gDead", name: null, retiredAt: "t9", slug: null });
    await seedMembers(db, "gA", 5);

    // The only NON-retired galaxy is named → the map is fully named despite the retired
    // unnamed row, and the public surfaces are live.
    expect(await isGalaxyMapFullyNamed()).toBe(true);
    expect((await listPublicGalaxies()).map((g) => g.slug)).toEqual(["the-liquid-deep"]);
    // The retired galaxy never appears publicly.
    expect((await listPublicGalaxies()).some((g) => g.slug === null)).toBe(false);
  });
});
