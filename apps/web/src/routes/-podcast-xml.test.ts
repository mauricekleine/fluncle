import { type MixtapeDTO } from "@fluncle/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function headResponse(length: number | null, ok = true): Response {
  return {
    headers: {
      get: (name: string) => (name === "content-length" && length !== null ? String(length) : null),
    },
    ok,
  } as unknown as Response;
}

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

  it("answers with the feed Cache-Control so a repeat poll is CDN-served", async () => {
    listMixtapes.mockResolvedValue([]);
    stubFetch(() => headResponse(null, false));

    const response = await getHandler()({});

    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    );
  });

  it("drops a mixtape whose audio object is missing (failed HEAD)", async () => {
    listMixtapes.mockResolvedValue([mixtape({ logId: "020.F.1A" })]);
    stubFetch(() => headResponse(null, false));

    const body = await render();

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
