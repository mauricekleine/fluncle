import { afterEach, describe, expect, it, vi } from "vitest";

// `/search`'s loader half — the THREE states, and the two decisions the persistent surface makes
// that the ⌘K palette does not have to.
//
// The primitive itself (four tiers, the ranking, the catalogue rule, the degradation contract) is
// proven against a real database in `lib/server/search.integration.test.ts`. What is proven HERE is
// the page's contract with it: that a blank query costs nothing, that a resolved coordinate is NOT
// followed as a redirect, and that a fault is named as a fault rather than dressed up as an empty
// result.

const searchArchive = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/search", () => ({ searchArchive }));
// The fault path logs and captures; neither is the thing under test, and both write to the console.
vi.mock("@/lib/server/log", () => ({ logEvent: vi.fn() }));
vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn() }));

const { SEARCH_PAGE_LIMIT, resolveSearchPageData } = await import("./-search-page-data");

afterEach(() => {
  vi.clearAllMocks();
});

/** The resolver's answer shape, with only the fields a case cares about spelled out. */
function answer(overrides: Record<string, unknown> = {}) {
  return { degraded: false, entities: [], kind: "token", results: [], ...overrides };
}

describe("the zero state costs nothing", () => {
  it.each([undefined, "", "   ", "a"])("resolves %o without touching the archive", async (q) => {
    await expect(resolveSearchPageData(q)).resolves.toEqual({ status: "blank" });
    expect(searchArchive).not.toHaveBeenCalled();
  });
});

describe("an answered query", () => {
  it("asks the ONE existing primitive, trimmed, at the page's own limit", async () => {
    searchArchive.mockResolvedValue(answer());

    await resolveSearchPageData("  netsky  ");

    expect(searchArchive).toHaveBeenCalledWith({ limit: SEARCH_PAGE_LIMIT, q: "netsky" });
  });

  it("carries the whole answer through, degradation and filters included", async () => {
    const response = answer({
      degraded: true,
      entities: [{ kind: "artist", name: "Netsky", slug: "netsky" }],
      filters: { key: "A minor" },
      results: [
        { artists: ["Netsky"], certified: true, logId: "004.7.2I", title: "X", trackId: "t" },
      ],
    });
    searchArchive.mockResolvedValue(response);

    const data = await resolveSearchPageData("netsky in A minor");

    expect(data).toEqual({ response, status: "answered" });
  });

  // THE DECISION A PERSISTENT URL FORCES. The palette may follow a `redirect` — it has no URL to
  // preserve. A page must not: bouncing would make `/search?q=004.7.2I` un-shareable, un-reloadable,
  // and a back-button trap (back to the search page, forward to the redirect, forever). The resolved
  // finding comes back as the first ROW instead, and the row itself is the link.
  it("does not follow a coordinate or entity redirect", async () => {
    const response = answer({
      kind: "coordinate",
      redirect: "/log/004.7.2I",
      results: [
        { artists: ["Netsky"], certified: true, logId: "004.7.2I", title: "X", trackId: "t" },
      ],
    });
    searchArchive.mockResolvedValue(response);

    const data = await resolveSearchPageData("004.7.2I");

    expect(data.status).toBe("answered");
    expect(data).toEqual({ response, status: "answered" });
  });
});

describe("a fault is a fault, not an empty result", () => {
  // "Nothing out here" would be a lie about an archive nobody managed to look inside, so the third
  // state exists purely so the page can say which of the two actually happened.
  it("names the failure instead of returning zero rows", async () => {
    searchArchive.mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(resolveSearchPageData("netsky")).resolves.toEqual({ status: "failed" });
  });

  // Caught, never rethrown: a rethrow would hand the page to the root error component, which takes
  // away the field the reader was typing into and the way onward.
  it("never lets the fault escape to the route", async () => {
    searchArchive.mockRejectedValue(new Error("boom"));

    await expect(resolveSearchPageData("netsky")).resolves.toBeDefined();
  });

  // The diagnostic half is not lost to the catch — this is the one and only server-side capture.
  it("captures the fault for the private diagnostics channel", async () => {
    const Sentry = await import("@sentry/cloudflare");
    const { logEvent } = await import("@/lib/server/log");
    const error = new Error("boom");
    searchArchive.mockRejectedValue(error);

    await resolveSearchPageData("netsky");

    expect(logEvent).toHaveBeenCalledWith("error", "search.page-fault", { error, query: "netsky" });
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { source: "search.page" },
    });
  });
});
