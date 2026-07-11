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

  it("carries the Listen destinations as external links", () => {
    const listen = navSections.find((section) => section.id === "listen");
    const hrefs = (listen?.items ?? []).flatMap((item) =>
      item.kind === "external" ? [item.href] : [],
    );

    expect(hrefs.some((href) => href.includes("spotify"))).toBe(true);
    expect(hrefs.some((href) => href.includes("radio."))).toBe(true);
  });

  it("keeps the operator-only /mix out of the public item lists", () => {
    const explore = navSections.find((section) => section.id === "explore");

    if (!explore) {
      throw new Error("explore section missing");
    }

    // It exists in the raw model (completeness) …
    expect(explore.items.some((item) => item.id === "mix")).toBe(true);
    // … but publicItems drops it (admin-gated).
    expect(publicItems(explore).some((item) => item.id === "mix")).toBe(false);
  });

  it("keeps a designed-but-unshipped Labels slot flagged future (never a live link)", () => {
    const explore = navSections.find((section) => section.id === "explore");
    const labels = explore?.items.find((item) => item.id === "labels");

    expect(labels?.future).toBe(true);
  });

  it("hides the galaxies lens until its runtime gate opens", () => {
    const explore = navSections.find((section) => section.id === "explore");

    if (!explore) {
      throw new Error("explore section missing");
    }

    expect(renderableItems(explore, false).some((item) => item.id === "galaxies")).toBe(false);
    expect(renderableItems(explore, true).some((item) => item.id === "galaxies")).toBe(true);
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
