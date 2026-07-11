import { describe, expect, it } from "vitest";
import { resolveCrumbs } from "./nav-breadcrumb";

// The breadcrumb is the colophon architecture's ONE per-page nav link, and the SEO
// counterweight to banking the rest of the nav in a boilerplate footer. It has to be
// right on every page, not just the leaves.

describe("resolveCrumbs", () => {
  it("renders nothing on home (a single dead crumb is not a trail)", () => {
    expect(resolveCrumbs("/")).toEqual([]);
  });

  it("renders nothing for an unmapped segment rather than guessing", () => {
    expect(resolveCrumbs("/nope/whatever")).toEqual([]);
  });

  it("makes an index page its own unlinked tail", () => {
    expect(resolveCrumbs("/log")).toEqual([{ label: "Log" }]);
    expect(resolveCrumbs("/artists")).toEqual([{ label: "Artists" }]);
  });

  it("hangs a finding off /log with the coordinate as the tail", () => {
    expect(resolveCrumbs("/log/038.6.1J")).toEqual([
      { label: "Log", to: "/log" },
      { label: "038.6.1J" },
    ]);
  });

  it("routes the singular /artist/<slug> to the plural /artists hub", () => {
    expect(resolveCrumbs("/artist/nu-tone")).toEqual([
      { label: "Artists", to: "/artists" },
      { label: "Nu Tone" },
    ]);
  });

  it("prefers an explicit leaf label over the slug (Nu:Tone, not nu-tone)", () => {
    expect(resolveCrumbs("/artist/nu-tone", "Nu:Tone")).toEqual([
      { label: "Artists", to: "/artists" },
      { label: "Nu:Tone" },
    ]);
  });

  it("reads a numbered newsletter edition as #3", () => {
    expect(resolveCrumbs("/newsletter/3")).toEqual([
      { label: "Newsletter", to: "/newsletter" },
      { label: "#3" },
    ]);
  });

  it("leaves a sector number alone", () => {
    expect(resolveCrumbs("/logbook/038")).toEqual([
      { label: "Logbook", to: "/logbook" },
      { label: "038" },
    ]);
  });

  it("hangs a docs page off /docs", () => {
    expect(resolveCrumbs("/docs/cli")).toEqual([{ label: "Docs", to: "/docs" }, { label: "Cli" }]);
  });
});
