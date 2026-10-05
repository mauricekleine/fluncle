import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaletteSearchCommit } from "./palette-search-commit";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("palette search commits", () => {
  it("waits for two seconds after the last keystroke instead of counting fetched prefixes", () => {
    const emit = vi.fn();
    const session = createPaletteSearchCommit(emit);

    for (const query of ["spe", "spec", "spectr", "spectrum"]) {
      session.settle(query, false);
      vi.advanceTimersByTime(180);
    }

    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1819);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit.mock.calls).toEqual([["spectrum"]]);
  });

  it("commits immediately on an action, dedupes settled queries, and accepts a different query", () => {
    const emit = vi.fn();
    const session = createPaletteSearchCommit(emit);
    session.settle("spectrum", false);
    session.commit("spectrum", false);
    vi.advanceTimersByTime(2000);
    session.commit(" spectrum ", false);
    session.settle("calibre", false);
    vi.advanceTimersByTime(2000);
    session.commit("calibre", false);
    session.commit("spectrum", false);

    expect(emit.mock.calls).toEqual([["spectrum"], ["calibre"]]);
  });

  it("never counts short queries or worked examples, including later actions", () => {
    const emit = vi.fn();
    const session = createPaletteSearchCommit(emit);

    for (const [query, example] of [
      ["", false],
      [" a ", false],
      ["calibre", true],
    ] as const) {
      session.settle(query, example);
      vi.advanceTimersByTime(2000);
      session.commit(query, example);
    }

    expect(emit).not.toHaveBeenCalled();
    session.settle("calibre edited", false);
    vi.advanceTimersByTime(2000);
    expect(emit.mock.calls).toEqual([["calibre edited"]]);
  });

  it("cancels pending idle work and allows the same query in a reopened session", () => {
    const emit = vi.fn();
    const session = createPaletteSearchCommit(emit);
    session.settle("spectrum", false);
    session.cancelIdle();
    vi.advanceTimersByTime(2000);
    expect(emit).not.toHaveBeenCalled();
    session.commit("spectrum", false);
    session.settle("calibre", false);
    session.reset();
    vi.advanceTimersByTime(2000);
    session.settle("spectrum", false);
    vi.advanceTimersByTime(2000);

    expect(emit.mock.calls).toEqual([["spectrum"], ["spectrum"]]);
  });

  it("counts a query at the two-character minimum", () => {
    const emit = vi.fn();
    const session = createPaletteSearchCommit(emit);
    session.commit(" ab ", false);

    expect(emit.mock.calls).toEqual([["ab"]]);
  });
});
