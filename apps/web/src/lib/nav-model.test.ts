import { describe, expect, it } from "vitest";
import {
  navFollow,
  navNerds,
  navRoutePaths,
  navSections,
  publicItems,
  renderableItems,
} from "./nav-model";

// The nav model is the ONE source every variant reads, so its completeness is the
// contract: every public index surface must be reachable, the admin-only + future
// slots must be flagged (never rendered as live public links), and the galaxies gate
// must actually hide the lens until it is live. Pin all of that here.

describe("nav model completeness", () => {
  it("reaches every public index surface", () => {
    const paths = navRoutePaths();

    for (const expected of [
      "/log",
      "/artists",
      "/labels",
      "/albums",
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

  // THE FORK. Browsing is two things, not one: what Fluncle DID out there (his own
  // objects — the log, the logbook, the galaxies, the mixtapes) and what he found it
  // AMONG (the music's own taxonomy — artists, albums, labels). A flat list of both
  // reads as a sitemap. Pin the split so a new surface has to choose a side.
  it("splits browsing into travelling along (what he did) and browsing (what he found it among)", () => {
    const travel = navSections.find((section) => section.id === "travel");
    const browse = navSections.find((section) => section.id === "browse");

    expect(travel?.label).toBe("Travel along");
    expect(browse?.label).toBe("Browse");
    expect(publicItems(travel ?? { id: "travel", items: [], label: "" }).map((item) => item.id)) //
      .toEqual(["log", "logbook", "galaxies", "mixtapes"]);
    expect(browse?.items.map((item) => item.id)).toEqual(["artists", "albums", "labels"]);
  });

  // Every heading is one plain word or phrase, and it names something you DO or someone you
  // are — Travel along / Browse / Listen / Crew. The two it replaced ("The trail", "The
  // crates") were abstract nouns that matched neither their siblings nor the canon. A
  // heading that opens with "The " is the tell that an abstraction crept back in.
  it("keeps every section heading plain, in the Listen/Crew register", () => {
    expect(navSections.map((section) => section.label)).toEqual([
      "Travel along",
      "Browse",
      "Listen",
      "Crew",
    ]);

    for (const section of navSections) {
      expect(section.label).not.toMatch(/^The /);
      // Sentence case: never an uppercase-tracked label (VOICE.md reserves caps for the
      // cover-art brand marks).
      expect(section.label).not.toBe(section.label.toUpperCase());
    }
  });

  // The word for the uncertified tier is INTERNAL and must never reach public copy
  // (docs/album-entity.md). The nav is public copy.
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

  // "Imprint" is trade-press English, not something the uncle says out loud. It is a label.
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

    // It exists in the raw model (completeness) …
    expect(travel.items.some((item) => item.id === "mix")).toBe(true);
    // … but publicItems drops it (admin-gated).
    expect(publicItems(travel).some((item) => item.id === "mix")).toBe(false);
  });

  it("renders the graph surfaces as live links (the Labels slot shipped)", () => {
    const browse = navSections.find((section) => section.id === "browse");
    const labels = browse?.items.find((item) => item.id === "labels");
    const albums = browse?.items.find((item) => item.id === "albums");

    // The `future` flag exists for a designed-but-unshipped slot; the Labels slot it was
    // introduced for is now a real route, and Albums landed with it. Neither may carry it —
    // a future item renders as a disabled "soon" slot, which would now be a lie.
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
