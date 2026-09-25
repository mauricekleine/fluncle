import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const mbFetch = vi.fn();
const fetchDiscogsLabelImage = vi.fn();
const readOptionalEnv = vi.fn();

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

vi.mock("./musicbrainz", async () => {
  const actual = await vi.importActual<typeof import("./musicbrainz")>("./musicbrainz");

  return { ...actual, mbFetch };
});

vi.mock("./discogs", async () => {
  const actual = await vi.importActual<typeof import("./discogs")>("./discogs");

  return { ...actual, fetchDiscogsLabelImage };
});

vi.mock("./env", () => ({ readOptionalEnv }));
vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { resolveLabelImages } = await import("./label-images");

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

const HOSPITAL = {
  discogs_label_id: null,
  image_failures: 0,
  mb_label_id: null,
  name: "Hospital Records",
  slug: "hospital-records",
};

function writtenSql(): string[] {
  return execute.mock.calls.slice(1).map((call) => String(call[0]?.sql ?? ""));
}

beforeEach(() => {
  execute.mockReset();
  mbFetch.mockReset();
  fetchDiscogsLabelImage.mockReset();
  readOptionalEnv.mockReset();
  readOptionalEnv.mockResolvedValue("discogs-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveLabelImages — the fallback ladder", () => {
  it("accepts box evidence only after repeating the label-id and primary-image checks", async () => {
    seedWorklist([{ ...HOSPITAL, discogs_label_id: 1111, mb_label_id: "mbid-hospital" }]);
    mbFetch.mockResolvedValueOnce({ data: { relations: [] }, rateLimited: false });
    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 4, false, undefined, {
      boxFetch: true,
      discogsCandidates: [
        {
          detail: {
            id: 1111,
            images: [{ type: "primary", uri: "https://i.discogs.com/logo.jpg" }],
          },
          discogsLabelId: 1111,
          image: {
            bytesBase64: "/9j/4AAQ",
            mime: "image/jpeg",
            uri: "https://i.discogs.com/logo.jpg",
          },
          slug: "hospital-records",
        },
      ],
    });

    expect(result.resolved).toEqual(["hospital-records"]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(fetchDiscogsLabelImage).not.toHaveBeenCalled();
    expect(writtenSql().some((sql) => sql.includes("image_state = 'resolved'"))).toBe(true);
  });

  it("rejects cross-wired box image bytes without writing a logo or terminal none verdict", async () => {
    seedWorklist([{ ...HOSPITAL, discogs_label_id: 1111, mb_label_id: "mbid-hospital" }]);
    mbFetch.mockResolvedValueOnce({ data: { relations: [] }, rateLimited: false });
    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 4, false, undefined, {
      boxFetch: true,
      discogsCandidates: [
        {
          detail: {
            id: 1111,
            images: [{ type: "primary", uri: "https://i.discogs.com/primary.jpg" }],
          },
          discogsLabelId: 1111,
          image: {
            bytesBase64: "/9j/4AAQ",
            mime: "image/jpeg",
            uri: "https://i.discogs.com/other.jpg",
          },
          slug: "hospital-records",
        },
      ],
    });

    expect(result.failed).toEqual([
      {
        error: "Discogs label evidence failed Worker verification",
        slug: "hospital-records",
      },
    ]);
    expect(result.none).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(writtenSql().some((sql) => sql.includes("image_state = 'none'"))).toBe(false);
  });

  it("resolves a label's logo via Discogs and stores it in R2", async () => {
    seedWorklist([HOSPITAL]);

    mbFetch
      .mockResolvedValueOnce({
        data: { labels: [{ id: "mbid-hospital", name: "Hospital Records" }] },
        rateLimited: false,
      })
      .mockResolvedValueOnce({
        data: {
          relations: [
            { type: "discogs", url: { resource: "https://www.discogs.com/label/1111-Hospital" } },
          ],
        },
        rateLimited: false,
      });
    fetchDiscogsLabelImage.mockResolvedValue({
      image: { bytes: new ArrayBuffer(64), mime: "image/jpeg" },
      rateLimited: false,
    });

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.resolved).toEqual(["hospital-records"]);
    expect(result.noneCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.rateLimited).toBe(false);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe("labels/hospital-records.jpg");
    expect(fetchDiscogsLabelImage).toHaveBeenCalledWith(1111, "discogs-token");

    expect(writtenSql().some((sql) => sql.includes("mb_label_id"))).toBe(true);
    expect(writtenSql().some((sql) => sql.includes("discogs_label_id"))).toBe(true);
    expect(writtenSql().some((sql) => sql.includes("image_state = 'resolved'"))).toBe(true);
  });

  it("falls back to the Wikidata P154 logo when Discogs has no image", async () => {
    seedWorklist([HOSPITAL]);
    mbFetch
      .mockResolvedValueOnce({
        data: { labels: [{ id: "mbid-hospital", name: "Hospital Records" }] },
        rateLimited: false,
      })

      .mockResolvedValueOnce({
        data: {
          relations: [
            { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q123" } },
          ],
        },
        rateLimited: false,
      });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("Special:EntityData")) {
        return new Response(
          JSON.stringify({
            entities: {
              Q123: { claims: { P154: [{ mainsnak: { datavalue: { value: "logo.png" } } }] } },
            },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }

      return new Response(new ArrayBuffer(128), {
        headers: { "content-type": "image/png" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.resolved).toEqual(["hospital-records"]);

    expect(fetchDiscogsLabelImage).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe("labels/hospital-records.png");
  });

  it("floors to 'none' (the cover fallback) when no image exists anywhere", async () => {
    seedWorklist([HOSPITAL]);
    mbFetch
      .mockResolvedValueOnce({
        data: { labels: [{ id: "mbid-hospital", name: "Hospital Records" }] },
        rateLimited: false,
      })

      .mockResolvedValueOnce({
        data: {
          relations: [
            { type: "discogs", url: { resource: "https://www.discogs.com/label/1111-Hospital" } },
          ],
        },
        rateLimited: false,
      });
    fetchDiscogsLabelImage.mockResolvedValue({ image: undefined, rateLimited: false });

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.none).toEqual(["hospital-records"]);
    expect(result.resolvedCount).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(writtenSql().some((sql) => sql.includes("image_state = 'none'"))).toBe(true);
  });

  it("keeps a Wikimedia failure retryable even after repeated attempts", async () => {
    seedWorklist([{ ...HOSPITAL, image_failures: 4, mb_label_id: "mbid-hospital" }]);
    mbFetch.mockResolvedValueOnce({
      data: {
        relations: [{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q123" } }],
      },
      rateLimited: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Wikimedia unavailable");
      }),
    );

    const { bucket } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.failed).toEqual([{ error: "Wikimedia unavailable", slug: "hospital-records" }]);
    expect(result.none).toEqual([]);
    const failureWrite = execute.mock.calls
      .slice(1)
      .find((call) => String(call[0]?.sql ?? "").includes("image_failures"));
    expect(String(failureWrite?.[0]?.sql ?? "")).toContain("image_state = 'pending'");
    expect(failureWrite?.[0]?.args?.[0]).toBe(5);
  });

  it("distinguishes a Wikimedia throttle from a genuine no-logo verdict", async () => {
    seedWorklist([{ ...HOSPITAL, mb_label_id: "mbid-hospital" }]);
    mbFetch.mockResolvedValueOnce({
      data: {
        relations: [{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q123" } }],
      },
      rateLimited: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );

    const { bucket } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.rateLimited).toBe(true);
    expect(result.none).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stops the pass (circuit breaker) when a vendor rate-limits, storing nothing", async () => {
    seedWorklist([HOSPITAL]);
    mbFetch.mockResolvedValueOnce({ data: null, rateLimited: true });

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.rateLimited).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.resolvedCount).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });

  it("is idempotent: a drained worklist fetches nothing and writes nothing", async () => {
    seedWorklist([]);

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.resolvedCount).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(mbFetch).not.toHaveBeenCalled();
    expect(fetchDiscogsLabelImage).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("previews the eligible worklist on a dry run without any vendor call or write", async () => {
    execute.mockResolvedValueOnce({ rows: [HOSPITAL] });

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, true);

    expect(result.dryRun).toBe(true);
    expect(result.resolved).toEqual(["hospital-records"]);
    expect(mbFetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reuses a crawler-persisted MBID (skips the MB search) and reports a resume cursor at the cap", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      discogs_label_id: 2000 + i,
      image_failures: 0,
      mb_label_id: `mbid-${i}`,
      name: `Label ${i}`,
      slug: `label-${i}`,
    }));
    seedWorklist(rows);

    mbFetch.mockResolvedValue({
      data: {
        relations: [{ type: "discogs", url: { resource: "https://www.discogs.com/label/9-X" } }],
      },
      rateLimited: false,
    });
    fetchDiscogsLabelImage.mockResolvedValue({
      image: { bytes: new ArrayBuffer(32), mime: "image/png" },
      rateLimited: false,
    });

    const { bucket } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.resolvedCount).toBe(4);

    expect(mbFetch).toHaveBeenCalledTimes(4);
    expect(result.nextCursor).toBe("label-3");
  });
});
