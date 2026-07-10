import { describe, expect, it } from "vitest";
import { isNamed, partitionGalaxyBoard } from "./galaxy-board";

// The `/admin/galaxies` naming view's pure view-model (Slice 3, browse-by-feel RFC):
// the three board states the view must render honestly — EMPTY (pre-fit), UNNAMED (the
// fit landed, nothing named yet), and NAMED — plus the launch-gate progress (n of N).

type Galaxy = { name: string | null; retiredAt: string | null; slug: string | null };

const galaxy = (over: Partial<Galaxy> = {}): Galaxy => ({
  name: null,
  retiredAt: null,
  slug: null,
  ...over,
});

describe("isNamed", () => {
  it("is true only when a galaxy carries BOTH a name and a slug", () => {
    expect(isNamed(galaxy({ name: "The Liquid Deep", slug: "the-liquid-deep" }))).toBe(true);
    // A half-written row (name set, slug not, or vice versa) is not yet named.
    expect(isNamed(galaxy({ name: "The Liquid Deep", slug: null }))).toBe(false);
    expect(isNamed(galaxy({ name: null, slug: "orphan-slug" }))).toBe(false);
    // Whitespace-only is empty.
    expect(isNamed(galaxy({ name: "  ", slug: "  " }))).toBe(false);
  });
});

describe("partitionGalaxyBoard", () => {
  it("EMPTY state: no galaxies → empty sections, zero progress", () => {
    const board = partitionGalaxyBoard([]);

    expect(board.namingQueue).toHaveLength(0);
    expect(board.namedGalaxies).toHaveLength(0);
    expect(board.retiredGalaxies).toHaveLength(0);
    expect(board.namedCount).toBe(0);
    expect(board.nameableCount).toBe(0);
  });

  it("UNNAMED state: the fresh k=9 fit → nine in the naming queue, 0 of 9 named", () => {
    const fit = Array.from({ length: 9 }, () => galaxy());

    const board = partitionGalaxyBoard(fit);

    expect(board.namingQueue).toHaveLength(9);
    expect(board.namedGalaxies).toHaveLength(0);
    expect(board.namedCount).toBe(0);
    expect(board.nameableCount).toBe(9);
  });

  it("PARTIAL state: some named, some not → the launch gate reads the split honestly", () => {
    const board = partitionGalaxyBoard([
      galaxy({ name: "The Liquid Deep", slug: "the-liquid-deep" }),
      galaxy({ name: "The Feral Steppers", slug: "the-feral-steppers" }),
      galaxy(),
      galaxy(),
    ]);

    expect(board.namedCount).toBe(2);
    expect(board.nameableCount).toBe(4);
    expect(board.namingQueue).toHaveLength(2);
    expect(board.namedGalaxies.map((entry) => entry.name)).toEqual([
      "The Liquid Deep",
      "The Feral Steppers",
    ]);
  });

  it("NAMED state: a fully named map → progress complete, empty naming queue", () => {
    const board = partitionGalaxyBoard([
      galaxy({ name: "Drifting Aurora", slug: "drifting-aurora" }),
      galaxy({ name: "Molten Amen", slug: "molten-amen" }),
    ]);

    expect(board.namingQueue).toHaveLength(0);
    expect(board.namedCount).toBe(2);
    expect(board.nameableCount).toBe(2);
    // The launch gate opens exactly when namedCount === nameableCount.
    expect(board.namedCount).toBe(board.nameableCount);
  });

  it("a retired galaxy never counts toward the launch gate, even if unnamed", () => {
    const board = partitionGalaxyBoard([
      galaxy({ name: "The Liquid Deep", slug: "the-liquid-deep" }),
      galaxy({ retiredAt: "2026-07-10T00:00:00.000Z" }),
    ]);

    // A never-named retiree (a machine handle from a superseded fit) is DROPPED from
    // the board entirely — it was never a place, so there is nothing to memorialize.
    expect(board.retiredGalaxies).toHaveLength(0);
    expect(board.namingQueue).toHaveLength(0);
    // The retired row is out of the map: one nameable galaxy, and it is named → gate open.
    expect(board.nameableCount).toBe(1);
    expect(board.namedCount).toBe(1);
  });

  it("a retired-but-named galaxy still lands in the retired tail, not the named map", () => {
    const board = partitionGalaxyBoard([
      galaxy({ name: "Old Region", retiredAt: "2026-07-10T00:00:00.000Z", slug: "old-region" }),
    ]);

    expect(board.retiredGalaxies).toHaveLength(1);
    expect(board.namedGalaxies).toHaveLength(0);
    expect(board.nameableCount).toBe(0);
  });
});
