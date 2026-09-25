import { afterEach, describe, expect, it, vi } from "vitest";

const searchArchive = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/search", () => ({ searchArchive }));

vi.mock("@/lib/server/log", () => ({ logEvent: vi.fn() }));
vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn() }));

const { SEARCH_PAGE_LIMIT, resolveSearchPageData } = await import("./-search-page-data");

afterEach(() => {
  vi.clearAllMocks();
});

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
  it("names the failure instead of returning zero rows", async () => {
    searchArchive.mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(resolveSearchPageData("netsky")).resolves.toEqual({ status: "failed" });
  });

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
