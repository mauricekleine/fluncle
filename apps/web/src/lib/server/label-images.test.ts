import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The label-image resolve sweep: give each label its OWN logo up the ladder
// Discogs → Wikidata → the cover floor. The DB, the MB client, the Discogs client, the
// env, and `fetch` (for Wikidata) are all mocked, so a test never hits a real database
// or the network. `parseDiscogsLabelUrl` is the REAL pure function (importActual).

const execute = vi.fn();
const mbFetch = vi.fn();
const fetchDiscogsLabelImage = vi.fn();
const readOptionalEnv = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./musicbrainz", async () => {
  const actual = await vi.importActual<typeof import("./musicbrainz")>("./musicbrainz");

  return { ...actual, mbFetch };
});

vi.mock("./discogs", async () => {
  const actual = await vi.importActual<typeof import("./discogs")>("./discogs");

  // Keep the real `parseDiscogsLabelUrl` (pure); mock only the networked image fetch.
  return { ...actual, fetchDiscogsLabelImage };
});

vi.mock("./env", () => ({ readOptionalEnv }));
vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { resolveLabelImages } = await import("./label-images");

/** A fake R2 bucket that records its `put`s (typed args, so `.mock.calls[i][0]` is the key). */
function fakeBucket() {
  const put = vi.fn(
    (_key: string, _value: ArrayBuffer | string, _options?: unknown): Promise<undefined> =>
      Promise.resolve(undefined),
  );

  return { bucket: { put } as unknown as Pick<R2Bucket, "put">, put };
}

/** The worklist SELECT returns these rows; every later write returns empty. */
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

/** The SQL of every write the pass issued (skipping the leading worklist SELECT). */
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
  it("resolves a label's logo via Discogs and stores it in R2", async () => {
    seedWorklist([HOSPITAL]);
    // MB label search → MBID, then its url-rels → a curated Discogs label relation.
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
    // Downloaded once and stored under our own key (never a Discogs hotlink).
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe("labels/hospital-records.jpg");
    expect(fetchDiscogsLabelImage).toHaveBeenCalledWith(1111, "discogs-token");
    // The identity ids were persisted + the row marked resolved.
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
      // url-rels carry ONLY a Wikidata link — no Discogs relation.
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

      // The Commons image itself.
      return new Response(new ArrayBuffer(128), {
        headers: { "content-type": "image/png" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bucket, put } = fakeBucket();
    const result = await resolveLabelImages(bucket, 50, false);

    expect(result.resolved).toEqual(["hospital-records"]);
    // Discogs was never consulted (no discogs id); the logo is the Wikidata one, as a .png.
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
      // A Discogs relation exists, but the label has no image on Discogs and no Wikidata.
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
    seedWorklist([]); // every label already resolved/none → not 'pending'.

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
    // Only the worklist SELECT ran — no writes.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reuses a crawler-persisted MBID (skips the MB search) and reports a resume cursor at the cap", async () => {
    // A full page (MAX_BATCH=4) of labels that already carry an MBID: the pass skips the MB
    // search and walks each label's url-rels directly. All resolve → the last slug is the cursor.
    const rows = Array.from({ length: 4 }, (_, i) => ({
      discogs_label_id: 2000 + i,
      image_failures: 0,
      mb_label_id: `mbid-${i}`,
      name: `Label ${i}`,
      slug: `label-${i}`,
    }));
    seedWorklist(rows);
    // Only the url-rels walk is called per label (no search) — one mbFetch each, all with a
    // Discogs relation already reflected by the pre-set discogs_label_id.
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
    // 4 url-rels walks, zero MB searches (the MBID was already stored).
    expect(mbFetch).toHaveBeenCalledTimes(4);
    expect(result.nextCursor).toBe("label-3");
  });
});
