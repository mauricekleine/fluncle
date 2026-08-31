// The FRONT DOOR's `head` and `beforeLoad` — everything `/` emits before a byte of body renders, and
// the one search param it still answers. No database: the head is a pure function of the loader's
// payload, so the fixtures below are hand-built (the `-about-schema.test.ts` shape) and each case
// states one contract the crawler, the browser, or an old shared link depends on.

import { describe, expect, it } from "vitest";
import { fluncleEntityId, fluncleWebsiteId } from "@/lib/fluncle-links";
import { albumCoverAtSize } from "@/lib/media";
import { Route } from "./index";

// A stored Spotify album-art URL at the 300² rung — the shape `tracks.album_image_url` actually
// holds, so `albumCoverAtSize` has a real rendition to move rather than a string it passes through.
const LEAD_COVER_URL = "https://i.scdn.co/image/ab67616d00001e0212ab34cd56ef7890abcd1234";

type HeadLink = { as?: string; fetchPriority?: string; href?: string; rel: string };

type HeadResult = {
  links?: HeadLink[];
  scripts?: Array<{ children: string; type: string }>;
};

type FrontDoorFinding = { artists: string[]; logId?: string; title: string };

type ItemListEntry = {
  "@type": string;
  item: { "@type": string; byArtist: unknown; genre?: string; name: string; url?: string };
  position: number;
};

/** The route's head for a given loader payload. `undefined` is the pre-loader render. */
function headOf(loaderData?: {
  findings: FrontDoorFinding[];
  lead?: FrontDoorFinding & { albumImageUrl?: string };
}): HeadResult {
  return Route.options.head?.({ loaderData } as never) as HeadResult;
}

// JSON-LD is emitted via `jsonLdScript`, which HTML-escapes the serialized JSON; those escapes are
// still valid JSON, so `JSON.parse` reads the original object back unchanged.
function schemasOf(head: HeadResult): Array<Record<string, unknown>> {
  return (head.scripts ?? [])
    .filter((script) => script.type === "application/ld+json")
    .map((script) => JSON.parse(script.children) as Record<string, unknown>);
}

/** The ItemList the CollectionPage hangs its findings on — the page's own claim about itself. */
function itemListOf(head: HeadResult): { itemListElement: ItemListEntry[]; numberOfItems: number } {
  const page = schemasOf(head).find((schema) => schema["@type"] === "CollectionPage");

  return (page?.mainEntity ?? { itemListElement: [], numberOfItems: 0 }) as {
    itemListElement: ItemListEntry[];
    numberOfItems: number;
  };
}

const LEAD: FrontDoorFinding & { albumImageUrl?: string } = {
  albumImageUrl: LEAD_COVER_URL,
  artists: ["Lead Artist"],
  logId: "004.7.2I",
  title: "The Lead",
};

const BAND: FrontDoorFinding[] = [
  { artists: ["Second Artist"], logId: "005.1.1A", title: "The Second" },
  // A row with no coordinate — the shape the band takes when a finding has not been minted.
  { artists: ["Third Artist"], title: "The Third" },
];

// The redirect the route throws is an object, not a return value, so it is captured out of the
// throw (the `-stories-redirects.test.ts` helper).
type ThrownRedirect = {
  options?: { params?: unknown; statusCode?: number; to?: string };
  params?: unknown;
  statusCode?: number;
  to?: string;
};

function captureRedirect(run: () => unknown): {
  params?: unknown;
  statusCode?: number;
  to?: string;
} {
  try {
    run();
  } catch (thrown) {
    const redirect = thrown as ThrownRedirect;
    const source = redirect.options ?? redirect;

    return { params: source.params, statusCode: source.statusCode, to: source.to };
  }

  throw new Error("expected a redirect to be thrown");
}

describe("/ head — the canonical", () => {
  it("self-canonicalizes to the bare root, exactly once", () => {
    const canonicals = (headOf({ findings: BAND, lead: LEAD }).links ?? []).filter(
      (link) => link.rel === "canonical",
    );

    // TanStack merges the root's `links` with the leaf's without deduping by rel, so a second
    // canonical anywhere up the tree would show up here as a duplicate.
    expect(canonicals).toHaveLength(1);
    expect(canonicals[0]?.href).toBe("https://www.fluncle.com/");
  });
});

describe("/ head — the LCP preload", () => {
  it("preloads the lead's cover at the exact rung the element renders", () => {
    const preloads = (headOf({ findings: BAND, lead: LEAD }).links ?? []).filter(
      (link) => link.rel === "preload",
    );

    expect(preloads).toHaveLength(1);
    expect(preloads[0]?.as).toBe("image");
    expect(preloads[0]?.fetchPriority).toBe("high");
    // The preload and the rendered <img> must resolve to ONE cache entry, so the expected URL is
    // derived from the same resizer the element goes through rather than written out by hand — a
    // rung drift on either side would otherwise cost the page two downloads instead of one.
    expect(preloads[0]?.href).toBe(albumCoverAtSize(LEAD_COVER_URL, "large"));
  });

  it("preloads nothing when the lead has no cover", () => {
    const head = headOf({
      findings: BAND,
      lead: { artists: ["Coverless"], logId: "006.1.1A", title: "No Sleeve" },
    });

    // A preload for a URL the page never requests is a wasted fetch competing with the ones it does.
    expect((head.links ?? []).some((link) => link.rel === "preload")).toBe(false);
  });

  it("preloads nothing when there is no lead at all", () => {
    expect((headOf({ findings: [] }).links ?? []).some((link) => link.rel === "preload")).toBe(
      false,
    );
  });
});

describe("/ head — the structured data", () => {
  it("carries the site-level WebSite node, published by the one canonical Fluncle entity", () => {
    const website = schemasOf(headOf({ findings: BAND, lead: LEAD })).find(
      (schema) => schema["@type"] === "WebSite",
    );

    expect(website?.["@id"]).toBe(fluncleWebsiteId);
    expect(website?.publisher).toEqual({ "@id": fluncleEntityId });
  });

  it("describes the lead plus the band and nothing more", () => {
    const list = itemListOf(headOf({ findings: BAND, lead: LEAD }));

    // The ItemList claims exactly what the page renders — never the whole archive, which would
    // claim more than the door carries.
    expect(list.numberOfItems).toBe(1 + BAND.length);
    expect(list.itemListElement).toHaveLength(1 + BAND.length);
    expect(list.itemListElement[0]?.position).toBe(1);
    expect(list.itemListElement[0]?.item.name).toBe(LEAD.title);
  });

  it("describes only the band when there is no lead", () => {
    const list = itemListOf(headOf({ findings: BAND }));

    expect(list.numberOfItems).toBe(BAND.length);
    expect(list.itemListElement[0]?.item.name).toBe(BAND[0]?.title);
  });

  it("types every entry as a drum & bass MusicRecording", () => {
    const list = itemListOf(headOf({ findings: BAND, lead: LEAD }));

    for (const entry of list.itemListElement) {
      expect(entry["@type"]).toBe("ListItem");
      expect(entry.item["@type"]).toBe("MusicRecording");
      expect(entry.item.genre).toBe("Drum and Bass");
    }
  });

  it("gives a fluncle.com URL to a coordinate-bearing finding and to nothing else", () => {
    const list = itemListOf(headOf({ findings: BAND, lead: LEAD }));
    const [lead, second, third] = list.itemListElement;

    expect(lead?.item.url).toBe("https://www.fluncle.com/log/004.7.2I");
    expect(second?.item.url).toBe("https://www.fluncle.com/log/005.1.1A");
    // The rail that stops the structured data claiming a certification that does not exist: a row
    // with no coordinate has no page, so it is handed no URL rather than a plausible-looking one.
    expect(third?.item).not.toHaveProperty("url");
  });

  it("emits nothing about findings before the loader has run", () => {
    const list = itemListOf(headOf());

    expect(list.numberOfItems).toBe(0);
    expect(list.itemListElement).toEqual([]);
  });
});

describe("/ beforeLoad — the ?story= redirect", () => {
  it("301s the raw masked URL to the standalone log page it always displayed", () => {
    const redirect = captureRedirect(() =>
      Route.options.beforeLoad?.({ search: { story: "004.7.2I" } } as never),
    );

    expect(redirect.to).toBe("/log/$logId");
    expect(redirect.statusCode).toBe(301);
    expect(redirect.params).toEqual({ logId: "004.7.2I" });
  });

  it("leaves the bare front door alone", () => {
    // `/` is the highest-traffic URL on the site; a redirect here would cost every visitor a hop.
    expect(() => Route.options.beforeLoad?.({ search: {} } as never)).not.toThrow();
  });
});

describe("/ validateSearch — the one param the door still answers", () => {
  function storyOf(search: Record<string, unknown>): string | undefined {
    return (
      Route.options.validateSearch as unknown as (input: Record<string, unknown>) => {
        story?: string;
      }
    )(search).story;
  }

  it("keeps a real coordinate so beforeLoad can forward it", () => {
    expect(storyOf({ story: "004.7.2I" })).toBe("004.7.2I");
  });

  it("folds a missing, empty, or non-string story to nothing at all", () => {
    // Every one of these would otherwise reach `beforeLoad` truthy enough to redirect somewhere
    // that cannot exist, so they are flattened to the bare front door.
    expect(storyOf({})).toBeUndefined();
    expect(storyOf({ story: "" })).toBeUndefined();
    expect(storyOf({ story: 7 })).toBeUndefined();
    expect(storyOf({ story: ["004.7.2I"] })).toBeUndefined();
  });
});
