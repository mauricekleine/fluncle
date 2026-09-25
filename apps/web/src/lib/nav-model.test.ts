import { describe, expect, it } from "vitest";
import {
  navBrowseHubs,
  navFollow,
  navNerds,
  navRoutePaths,
  navSections,
  publicItems,
  renderableItems,
} from "./nav-model";

describe("nav model completeness", () => {
  it("reaches every public index surface", () => {
    const paths = navRoutePaths();

    for (const expected of [
      "/search",
      "/log",
      "/artists",
      "/labels",
      "/albums",
      "/fresh",
      "/galaxies",
      "/logbook",
      "/mixtapes",
      "/about",
      "/newsletter",
      "/account",
      "/docs",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("splits browsing into travelling along (what he did) and browsing (what he found it among)", () => {
    const travel = navSections.find((section) => section.id === "travel");
    const browse = navSections.find((section) => section.id === "browse");

    expect(travel?.label).toBe("Travel along");
    expect(browse?.label).toBe("Browse");
    expect(
      publicItems(travel ?? { id: "travel", items: [], label: "" }).map((item) => item.id),
    ).toEqual(["findings", "log", "logbook", "galaxies", "mixtapes"]);
    expect(browse?.items.map((item) => item.id)).toEqual([
      "search",
      "tracks",
      "artists",
      "albums",
      "labels",
      "fresh",
    ]);
  });

  it("keeps every section heading plain, in the Listen/Crew register", () => {
    expect(navSections.map((section) => section.label)).toEqual([
      "Travel along",
      "Browse",
      "Listen",
      "Crew",
    ]);

    for (const section of navSections) {
      expect(section.label).not.toMatch(/^The /);

      expect(section.label).not.toBe(section.label.toUpperCase());
    }
  });

  it("never says the internal word for the unnamed tier", () => {
    const copy = navSections
      .flatMap((section) => [
        section.label,
        ...section.items.map((item) => `${item.label} ${item.blurb ?? ""}`),
      ])
      .join(" ")
      .toLowerCase();

    expect(copy).not.toContain("catalog");
  });

  it("never says imprint", () => {
    const copy = navSections
      .flatMap((section) => [
        section.label,
        ...section.items.map((item) => `${item.label} ${item.blurb ?? ""}`),
      ])
      .join(" ")
      .toLowerCase();

    expect(copy).not.toContain("imprint");
  });

  it("carries the Listen destinations as external links", () => {
    const listen = navSections.find((section) => section.id === "listen");
    const hrefs = (listen?.items ?? []).flatMap((item) =>
      item.kind === "external" ? [item.href] : [],
    );

    expect(hrefs.some((href) => href.includes("spotify"))).toBe(true);
    expect(hrefs.some((href) => href.includes("radio."))).toBe(true);
  });

  it("keeps the operator-only /mix out of the public item lists", () => {
    const travel = navSections.find((section) => section.id === "travel");

    if (!travel) {
      throw new Error("travel section missing");
    }

    expect(travel.items.some((item) => item.id === "mix")).toBe(true);

    expect(publicItems(travel).some((item) => item.id === "mix")).toBe(false);
  });

  it("renders the graph surfaces as live links (the Labels slot shipped)", () => {
    const browse = navSections.find((section) => section.id === "browse");
    const labels = browse?.items.find((item) => item.id === "labels");
    const albums = browse?.items.find((item) => item.id === "albums");

    expect(labels?.future).toBeUndefined();
    expect(albums?.future).toBeUndefined();
    expect(renderableItems(browse ?? { id: "browse", items: [], label: "" }, true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "labels", to: "/labels" }),
        expect.objectContaining({ id: "albums", to: "/albums" }),
      ]),
    );
  });

  it("hides the galaxies lens until its runtime gate opens", () => {
    const travel = navSections.find((section) => section.id === "travel");

    if (!travel) {
      throw new Error("travel section missing");
    }

    expect(renderableItems(travel, false).some((item) => item.id === "galaxies")).toBe(false);
    expect(renderableItems(travel, true).some((item) => item.id === "galaxies")).toBe(true);
  });

  it("lists the full Follow row and the nerds surfaces", () => {
    expect(navFollow.length).toBeGreaterThanOrEqual(9);
    expect(navNerds.map((nerd) => nerd.id)).toEqual(["cli", "dig", "git", "mcp", "ssh"]);
  });

  it("gives every item and social a unique id", () => {
    const ids = [
      ...navSections.flatMap((section) => section.items.map((item) => item.id)),
      ...navFollow.map((social) => social.id),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the Browse menu's hubs", () => {
  it("are the five catalogue hubs, in the ruled order, archive only", () => {
    expect(navBrowseHubs.map((item) => (item.kind === "route" ? item.to : item.id))).toEqual([
      "/tracks",
      "/artists",
      "/albums",
      "/labels",
      "/fresh",
    ]);
  });

  it("reuse the colophon's own label and blurb for each hub", () => {
    const browse = navSections.find((section) => section.id === "browse");

    for (const hub of navBrowseHubs) {
      expect(browse?.items).toContainEqual(hub);
      expect(hub.blurb).toBeTruthy();
    }
  });
});
