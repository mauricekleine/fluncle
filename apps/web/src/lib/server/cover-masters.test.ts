import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return {
    ...actual,
    getDb: async () => ({
      batch: (statements: { args?: unknown[]; sql: string }[]) =>
        Promise.all(
          statements.map((statement) =>
            statement.sql.includes("insert into due_work")
              ? Promise.resolve({ rows: [], rowsAffected: 1 })
              : execute(statement),
          ),
        ),
      execute,
    }),
  };
});

vi.mock("./due-work-cutover", () => ({ isDueWorkCutoverEnabled: async () => false }));

vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { coverMasterKey, downloadCappedImage, readImageSize, resolveCoverMasters } =
  await import("./cover-masters");

function pngBytes(w: number, h: number): ArrayBuffer {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, w);
  view.setUint32(20, h);

  return buf;
}

function jpegBytes(w: number, h: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  view.setUint16(4, 17);
  bytes[6] = 8;
  view.setUint16(7, h);
  view.setUint16(9, w);

  return bytes.buffer;
}

function fakeBucket() {
  const put = vi.fn(
    (_key: string, _value: ArrayBuffer | string, _options?: unknown): Promise<undefined> =>
      Promise.resolve(undefined),
  );

  return { bucket: { put } as unknown as Pick<R2Bucket, "put">, put };
}

function seedWorklist(rows: unknown[]): void {
  execute.mockResolvedValueOnce({ rows });
  execute.mockResolvedValue({ rows: [] });
}

function stubImageFetch(png: ArrayBuffer, contentType = "image/png") {
  const fetchMock = vi.fn(
    async (_url: string) =>
      new Response(png, { headers: { "content-type": contentType }, status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function writtenCalls(): Array<{ args: unknown[]; sql: string }> {
  return execute.mock.calls.slice(1).map((call) => ({
    args: (call[0]?.args ?? []) as unknown[],
    sql: String(call[0]?.sql ?? ""),
  }));
}

const APPLE_TEMPLATE = "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg";

beforeEach(() => {
  execute.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readImageSize — the dimension guard", () => {
  it("reads PNG dimensions", () => {
    expect(readImageSize(pngBytes(1200, 900))).toEqual({ height: 900, width: 1200 });
  });

  it("reads baseline JPEG dimensions", () => {
    expect(readImageSize(jpegBytes(640, 480))).toEqual({ height: 480, width: 640 });
  });

  it("returns undefined for an unrecognised container", () => {
    expect(readImageSize(new ArrayBuffer(32))).toBeUndefined();
  });
});

describe("downloadCappedImage — the ≤1200 cap", () => {
  it("stores a ≤1200 image", async () => {
    stubImageFetch(pngBytes(1200, 1200));
    const image = await downloadCappedImage("https://found/x.png");

    expect(image?.mime).toBe("image/png");
  });

  it("REJECTS an image larger than 1200 on its longest side (no un-downscaled original)", async () => {
    stubImageFetch(pngBytes(3000, 3000));
    const image = await downloadCappedImage("https://found/x.png");

    expect(image).toBeUndefined();
  });

  it("a 404 is a definitive miss (undefined), never a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not here", { status: 404 })),
    );

    expect(
      await downloadCappedImage("https://coverartarchive.org/release/x/front-500"),
    ).toBeUndefined();
  });

  it("a 503 THROWS (transient outage → the row lands failed + cooldown, never terminal none)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 503 })),
    );

    await expect(
      downloadCappedImage("https://coverartarchive.org/release/x/front-500"),
    ).rejects.toThrow(/transient source error 503/);
  });
});

describe("resolveCoverMasters — the album ladder", () => {
  it("resolves via the Apple template, requesting a ≤1200 rendition and stamping source=apple", async () => {
    seedWorklist([
      {
        artwork_height: 3000,
        artwork_url_template: APPLE_TEMPLATE,
        artwork_width: 3000,
        cover_url: "https://i.scdn.co/image/ab67616d00001e02abc",
        image_failures: 0,
        slug: "some-album",
      },
    ]);
    const fetchMock = stubImageFetch(pngBytes(1200, 1200));

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(result.resolved).toEqual(["some-album"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/abc/1200x1200bb.jpg",
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe("albums/some-album.png");
    const resolvedWrite = writtenCalls().find((c) => c.sql.includes("image_state = 'resolved'"));
    expect(resolvedWrite?.args).toContain("apple");
  });

  it("falls to Cover Art Archive (front-1200) when there is no Apple template", async () => {
    seedWorklist([
      {
        artwork_height: null,
        artwork_url_template: null,
        artwork_width: null,
        cover_url: "https://coverartarchive.org/release/mbid-1/front-500",
        image_failures: 0,
        slug: "caa-album",
      },
    ]);
    const fetchMock = stubImageFetch(pngBytes(1000, 1000));

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(result.resolved).toEqual(["caa-album"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://coverartarchive.org/release/mbid-1/front-1200",
    );
    expect(put).toHaveBeenCalledTimes(1);
    const resolvedWrite = writtenCalls().find((c) => c.sql.includes("image_state = 'resolved'"));
    expect(resolvedWrite?.args).toContain("coverart");
  });

  it("falls to the Spotify 640 floor and requests the largest prefix", async () => {
    seedWorklist([
      {
        artwork_height: null,
        artwork_url_template: null,
        artwork_width: null,
        cover_url: "https://i.scdn.co/image/ab67616d00001e02deadbeef",
        image_failures: 0,
        slug: "spotify-album",
      },
    ]);
    const fetchMock = stubImageFetch(pngBytes(640, 640));

    const { bucket } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(result.resolved).toEqual(["spotify-album"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://i.scdn.co/image/ab67616d0000b273deadbeef");
    const resolvedWrite = writtenCalls().find((c) => c.sql.includes("image_state = 'resolved'"));
    expect(resolvedWrite?.args).toContain("spotify");
  });

  it("does NOT store an oversized source — every rung rejects it and floors to none (the cap, end to end)", async () => {
    seedWorklist([
      {
        artwork_height: 3000,
        artwork_url_template: APPLE_TEMPLATE,
        artwork_width: 3000,
        cover_url: "https://i.scdn.co/image/ab67616d00001e02abc",
        image_failures: 0,
        slug: "rogue-album",
      },
    ]);

    stubImageFetch(pngBytes(3000, 3000));

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(put).not.toHaveBeenCalled();
    expect(result.resolvedCount).toBe(0);
    expect(result.noneCount).toBe(1);
    expect(writtenCalls().some((c) => c.sql.includes("image_state = 'none'"))).toBe(true);
  });

  it("records a FAILURE (backoff, retryable) when a source fetch throws — never terminal none", async () => {
    seedWorklist([
      {
        artwork_height: 1400,
        artwork_url_template: APPLE_TEMPLATE,
        artwork_width: 1400,
        cover_url: null,
        image_failures: 0,
        slug: "flaky-album",
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(put).not.toHaveBeenCalled();
    expect(result.failedCount).toBe(1);
    expect(writtenCalls().some((c) => c.sql.includes("image_failures ="))).toBe(true);
  });

  it("floors to 'none' when the album has no usable source", async () => {
    seedWorklist([
      {
        artwork_height: null,
        artwork_url_template: null,
        artwork_width: null,
        cover_url: null,
        image_failures: 0,
        slug: "bare-album",
      },
    ]);

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(result.none).toEqual(["bare-album"]);
    expect(put).not.toHaveBeenCalled();
    expect(writtenCalls().some((c) => c.sql.includes("image_state = 'none'"))).toBe(true);
  });
});

describe("resolveCoverMasters — the artist floor + the shared cap", () => {
  it("owns the artist's Spotify avatar as a ≤1200 master", async () => {
    seedWorklist([
      {
        image_failures: 0,
        image_url: "https://i.scdn.co/image/ab6761610000e5ebcafe",
        slug: "some-artist",
      },
    ]);
    const fetchMock = stubImageFetch(jpegBytes(640, 640), "image/jpeg");

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "artist", 50, false);

    expect(result.resolved).toEqual(["some-artist"]);
    expect(put.mock.calls[0]?.[0]).toBe("artists/some-artist.jpg");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://i.scdn.co/image/ab6761610000e5ebcafe");
    const resolvedWrite = writtenCalls().find((c) => c.sql.includes("image_state = 'resolved'"));
    expect(resolvedWrite?.sql).toContain("update artists");
    expect(resolvedWrite?.args).toContain("spotify");
  });

  it("caps an oversized artist source too (rejects, never stores)", async () => {
    seedWorklist([
      {
        image_failures: 0,
        image_url: "https://i.scdn.co/image/ab6761610000e5ebcafe",
        slug: "rogue-artist",
      },
    ]);
    stubImageFetch(pngBytes(2400, 2400));

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "artist", 50, false);

    expect(put).not.toHaveBeenCalled();
    expect(result.noneCount).toBe(1);
  });
});

describe("resolveCoverMasters — sweep discipline", () => {
  it("previews the worklist on a dry run without any fetch or write", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          artwork_height: null,
          artwork_url_template: null,
          artwork_width: null,
          cover_url: "https://i.scdn.co/image/ab67616d00001e02abc",
          image_failures: 0,
          slug: "dry-album",
        },
      ],
    });
    const fetchMock = stubImageFetch(pngBytes(640, 640));

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, true);

    expect(result.dryRun).toBe(true);
    expect(result.resolved).toEqual(["dry-album"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a drained worklist fetches nothing and writes nothing", async () => {
    seedWorklist([]);
    const fetchMock = stubImageFetch(pngBytes(640, 640));

    const { bucket, put } = fakeBucket();
    const result = await resolveCoverMasters(bucket, "album", 50, false);

    expect(result.resolvedCount).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("keys albums and artists under distinct prefixes", () => {
    expect(coverMasterKey("album", "foo", "image/jpeg")).toBe("albums/foo.jpg");
    expect(coverMasterKey("artist", "foo", "image/png")).toBe("artists/foo.png");
  });
});
