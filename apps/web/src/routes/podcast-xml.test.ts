import { type MixtapeDTO } from "@fluncle/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The /podcast.xml route emits one RSS episode per published mixtape, enclosing
// its `<logId>/mixtape.m4a` audio. An episode whose audio object isn't really
// there (failed/zero-length HEAD) must be DROPPED, not emitted as a broken
// enclosure a podcast app can't play. We mock the server query + the HEAD probe.

const listMixtapes = vi.hoisted(() => vi.fn<() => Promise<MixtapeDTO[]>>());

vi.mock("../lib/server/mixtapes", () => ({ listMixtapes }));

const { Route } = await import("./podcast[.]xml");

const realFetch = globalThis.fetch;

function getHandler() {
  const handlers = Route.options.server?.handlers as
    | { GET: (ctx: unknown) => Promise<Response> }
    | undefined;
  if (!handlers) {
    throw new Error("podcast route has no GET handler");
  }
  return handlers.GET;
}

function mixtape(overrides: Partial<MixtapeDTO>): MixtapeDTO {
  return {
    artists: ["Fluncle"],
    externalUrls: {},
    memberCount: 0,
    members: [],
    recordedAt: "2026-06-18T00:00:00.000Z",
    status: "published",
    title: "Fluncle Drum & Bass Mixtape",
    type: "mixtape",
    ...overrides,
  };
}

/** A HEAD response with a given Content-Length (or a failed/absent one). */
function headResponse(length: number | null, ok = true): Response {
  return {
    headers: {
      get: (name: string) => (name === "content-length" && length !== null ? String(length) : null),
    },
    ok,
  } as unknown as Response;
}

/** Install a stub fetch for the route's HEAD probe. */
function stubFetch(impl: (url: string) => Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    return impl(url);
  }) as unknown as typeof fetch;
}

async function render(): Promise<string> {
  const response = await getHandler()({});
  return response.text();
}

describe("/podcast.xml audio-presence guard", () => {
  beforeEach(() => {
    listMixtapes.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("drops a mixtape whose audio object is missing (failed HEAD)", async () => {
    listMixtapes.mockResolvedValue([mixtape({ logId: "020.F.1A" })]);
    stubFetch(() => headResponse(null, false));

    const body = await render();

    // The feed is still a valid channel — just with no broken episode in it.
    expect(body).toContain("<channel>");
    expect(body).not.toContain("<item>");
    expect(body).not.toContain("020.F.1A");
  });

  it("drops a mixtape with a zero-length audio object", async () => {
    listMixtapes.mockResolvedValue([mixtape({ logId: "020.F.1B" })]);
    stubFetch(() => headResponse(0));

    const body = await render();

    expect(body).not.toContain("<item>");
  });

  it("emits a mixtape with real audio, enclosing the byte length", async () => {
    listMixtapes.mockResolvedValue([mixtape({ logId: "020.F.1C" })]);
    stubFetch(() => headResponse(12_345_678));

    const body = await render();

    expect(body).toContain("<item>");
    expect(body).toContain("020.F.1C");
    expect(body).toContain('length="12345678"');
  });

  it("emits only the episodes that have audio in a mixed list", async () => {
    listMixtapes.mockResolvedValue([
      mixtape({ logId: "020.F.2A" }),
      mixtape({ logId: "020.F.2B" }),
    ]);
    stubFetch((url) => (url.includes("020.F.2A") ? headResponse(999) : headResponse(null, false)));

    const body = await render();

    expect(body).toContain("020.F.2A");
    expect(body).not.toContain("020.F.2B");
    expect(body.match(/<item>/g)?.length).toBe(1);
  });
});
