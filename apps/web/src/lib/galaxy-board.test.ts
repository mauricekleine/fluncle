import { describe, expect, it } from "vitest";
import { isNamed, partitionGalaxyBoard } from "./galaxy-board";

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

    expect(isNamed(galaxy({ name: "The Liquid Deep", slug: null }))).toBe(false);
    expect(isNamed(galaxy({ name: null, slug: "orphan-slug" }))).toBe(false);

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

    expect(board.namedCount).toBe(board.nameableCount);
  });

  it("a retired galaxy never counts toward the launch gate, even if unnamed", () => {
    const board = partitionGalaxyBoard([
      galaxy({ name: "The Liquid Deep", slug: "the-liquid-deep" }),
      galaxy({ retiredAt: "2026-07-10T00:00:00.000Z" }),
    ]);

    expect(board.retiredGalaxies).toHaveLength(0);
    expect(board.namingQueue).toHaveLength(0);

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
