// ChatDnB's tools against a REAL libSQL database — the half `chat.test.ts` cannot reach.
//
// `chat.test.ts` proves the tool SHAPE and the register-split MAPPING with every DB module mocked;
// this proves the `execute` CLOSURES — the only DB-touching part, the part that actually answers a
// raver — by running each one against the migrated schema (the finding inner-join, the FTS5 index,
// the label/album graph pointers, the mix engine's key pre-filter + `vector_distance_cos`, the
// artist-similarity precompute). A broken archive lookup inside chat ships green without this.
//
// Only true externals are mocked: the search LLM tier (`./search-llm`), Spotify (`./spotify`), and
// Resend (`./resend`). The DB and every query module run for real. Each tool's `execute` is invoked
// exactly as the chat surface invokes it (`buildChatTools(request)[name].execute(args, options)` —
// `transport: "chat"` is baked in by the adapter).

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkTrackToAlbum } from "./albums";
import { rankArtists } from "./artist-dossier";
import { createIntegrationDb, seedArtist, seedCatalogueTrack, seedTrack } from "./integration-db";
import { linkTrackToLabel } from "./labels";

// ── The mocked externals ───────────────────────────────────────────────────────────────

// The search LLM tier is a network call. Stubbed to `null` (unprovisioned) so search_archive stays
// on its deterministic tiers — the ones that read the real DB — exactly as `search.integration.test`.
const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

// Spotify is a network call. `submit_track` reads `searchTrackCandidates`; `createSubmission`
// downstream reads `fetchTrackMetadata`. Both stubbed; `ApiError` (which the tools throw and the
// dispatcher `instanceof`-checks) stays REAL.
const searchTrackCandidates = vi.hoisted(() => vi.fn<(query: string) => Promise<unknown[]>>());
const fetchTrackMetadata = vi.hoisted(() => vi.fn<(trackId: string) => Promise<unknown>>());

vi.mock("./spotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spotify")>()),
  fetchTrackMetadata,
  searchTrackCandidates,
}));

// Resend is a network + env call. `subscribe_newsletter` → `subscribeToNewsletter` → this.
const addContactToSegment = vi.hoisted(() => vi.fn<(email: string) => Promise<void>>());

vi.mock("./resend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resend")>()),
  addContactToSegment,
}));

// The one live database, swapped in fresh per test. `getDb` closes over it, so the REAL query
// modules run REAL SQL against the REAL migrated schema (+ FTS index). `getDrizzleDb` is overridden
// too: it calls db.ts's MODULE-INTERNAL `getDb` (which the export mock cannot reach), so the write
// tools' `getPublicSession` (better-auth over drizzle) would otherwise fall through to real Turso.
let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("../../db/schema");

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
    getDrizzleDb: () => Promise.resolve(drizzle(db, { schema })),
  };
});

import { buildChatTools } from "./chat";

// The write tools resolve a public session (better-auth over the mocked drizzle db). Better-auth
// refuses to construct without a base URL + secret; these are config, not a session (the test
// requests carry no cookie, so the resolved session is always null). Set only when absent.
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-secret-chat-tools-integration";

// ── Helpers ────────────────────────────────────────────────────────────────────────────

type ToolName = keyof ReturnType<typeof buildChatTools>;

/** The chat tool's `execute`, invoked as the AI-SDK surface invokes it (options carry no signal). */
function toolExecute(name: ToolName, request?: Request) {
  const tool = buildChatTools(request)[name];
  const execute = tool?.execute;

  if (typeof execute !== "function") {
    throw new Error(`${name} executor missing`);
  }

  return (args: Record<string, unknown>): Promise<unknown> =>
    execute(args as never, {} as never) as Promise<unknown>;
}

/** Stamp a track's musical key + BPM (seedTrack leaves both NULL; the mix engine needs the key). */
async function setKeyBpm(trackId: string, key: string, bpm: number): Promise<void> {
  await db.execute({
    args: [key, bpm, trackId],
    sql: `update tracks set "key" = ?, bpm = ? where track_id = ?`,
  });
}

/** Stamp a track's release date (seedTrack leaves it NULL; list_fresh's window needs it). */
async function setReleaseDate(trackId: string, date: string): Promise<void> {
  await db.execute({
    args: [date, trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });
}

/** Stamp a track's raw album string (catalogue-groups groups by it). */
async function setAlbum(trackId: string, album: string): Promise<void> {
  await db.execute({
    args: [album, trackId],
    sql: `update tracks set album = ? where track_id = ?`,
  });
}

/** Link a track to an artist entity (the `track_artists` graph edge; lead = position 1). */
async function linkArtist(trackId: string, artistId: string): Promise<void> {
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
}

const DIMS = 1024;

/** A unit vector along one axis — an "artificial genre" a track can be aimed at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

/** Normalize to unit length (a real MuQ vector is unit-length). */
function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

/** A vector `weight` of the way from `from` toward `toward` — a controlled near-neighbour. */
function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

/** The write the embed pipeline performs: validated JSON → ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  await db.execute({
    args: [JSON.stringify(vector), trackId],
    sql: `update tracks set embedding_blob = vector32(?) where track_id = ?`,
  });
}

/** A request carrying an IP, so the write tools' rate-limit key resolves (no session needed). */
function ipRequest(): Request {
  return new Request("https://fluncle.com/api/chat", {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  translateQuery.mockReset();
  translateQuery.mockResolvedValue(null);
  searchTrackCandidates.mockReset();
  fetchTrackMetadata.mockReset();
  addContactToSegment.mockReset();
  addContactToSegment.mockResolvedValue(undefined);
});

afterEach(() => {
  db.close();
});

// ── list_findings ─────────────────────────────────────────────────────────────────────

describe("list_findings — the recent findings feed read", () => {
  it("returns the certified findings newest-first, as compact cards", async () => {
    await seedTrack(db, { logId: "001.1.1A", title: "First", trackId: "t-1" });
    await seedTrack(db, { logId: "002.1.1A", title: "Second", trackId: "t-2" });
    // A catalogue track (no findings row) must never surface on this findings-only read.
    await seedCatalogueTrack(db, { title: "Uncertified", trackId: "cat-1" });

    const result = (await toolExecute("list_findings")({ limit: 10 })) as {
      findings: { coordinate?: string; title: string }[];
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.title).sort()).toEqual(["First", "Second"]);
    for (const finding of result.findings) {
      expect(finding.coordinate).toBeTruthy();
    }
  });

  it("returns an empty findings list for an empty archive (never a throw)", async () => {
    const result = (await toolExecute("list_findings")({})) as { findings: unknown[]; ok: boolean };

    expect(result).toEqual({ findings: [], ok: true });
  });
});

// ── list_tracks (the reborn browse enumerator) ──────────────────────────────────────────

describe("list_tracks — the whole-archive browse enumerator", () => {
  it("returns both registers as flat certified-tagged rows (the Unlit Rule in the row)", async () => {
    await seedTrack(db, { logId: "001.1.1A", title: "Certified", trackId: "t-1" });
    await seedCatalogueTrack(db, { title: "Uncertified", trackId: "cat-1" });

    const result = (await toolExecute("list_tracks")({})) as {
      ok: boolean;
      page: number;
      tracks: { certified: boolean; logId?: string; title: string }[];
    };

    expect(result.ok).toBe(true);
    expect(result.page).toBe(1);
    expect(result.tracks.map((row) => row.title).sort()).toEqual(["Certified", "Uncertified"]);
    const certified = result.tracks.find((row) => row.title === "Certified");
    const uncertified = result.tracks.find((row) => row.title === "Uncertified");
    expect(certified?.certified).toBe(true);
    expect(certified?.logId).toBeTruthy();
    // The Unlit Rule: an uncertified row carries no coordinate.
    expect(uncertified?.certified).toBe(false);
    expect(uncertified?.logId).toBeUndefined();
  });

  it("narrows to the certified register when certified=true", async () => {
    await seedTrack(db, { logId: "001.1.1A", title: "Certified", trackId: "t-1" });
    await seedCatalogueTrack(db, { title: "Uncertified", trackId: "cat-1" });

    const result = (await toolExecute("list_tracks")({ certified: true })) as {
      tracks: { title: string }[];
    };

    expect(result.tracks.map((row) => row.title)).toEqual(["Certified"]);
  });
});

// ── list_fresh ─────────────────────────────────────────────────────────────────────────

describe("list_fresh — what just came out", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("splits recent releases into lit findings and unlit catalogue rows", async () => {
    await seedTrack(db, { logId: "003.1.1A", title: "Fresh Finding", trackId: "fresh-cert" });
    await setReleaseDate("fresh-cert", today);
    await seedCatalogueTrack(db, {
      artists: ["Ghost"],
      title: "Fresh Catalogue",
      trackId: "fresh-cat",
    });
    await setReleaseDate("fresh-cat", today);

    const result = (await toolExecute("list_fresh")({})) as {
      catalogue: { coordinate?: string; title: string }[];
      findings: { coordinate?: string; releaseDate?: string; title: string }[];
      ok: boolean;
    };

    expect(result.findings.map((finding) => finding.title)).toEqual(["Fresh Finding"]);
    expect(result.findings[0]?.coordinate).toBe("003.1.1A");
    expect(result.findings[0]?.releaseDate).toBe(today);

    expect(result.catalogue.map((row) => row.title)).toEqual(["Fresh Catalogue"]);
    // An unlit catalogue row carries a title + artists + a way out, never a coordinate.
    expect(result.catalogue[0]?.coordinate).toBeUndefined();
  });

  it("returns nothing came out for an empty window (an honest empty, not a throw)", async () => {
    const result = (await toolExecute("list_fresh")({})) as {
      catalogue?: unknown[];
      findings?: unknown[];
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    // dropEmpty strips both empty buckets — the honest "nothing landed".
    expect(result.findings ?? []).toEqual([]);
    expect(result.catalogue ?? []).toEqual([]);
  });
});

// ── get_track ──────────────────────────────────────────────────────────────────────────

describe("get_track — resolve one coordinate", () => {
  it("resolves a finding by its Log ID to a compact card", async () => {
    await seedTrack(db, { logId: "004.7.2I", title: "Better Places", trackId: "t-bp" });

    const result = (await toolExecute("get_track")({ idOrLogId: "004.7.2I" })) as {
      finding: { coordinate?: string; title: string };
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.finding.title).toBe("Better Places");
    expect(result.finding.coordinate).toBe("004.7.2I");
  });

  it("resolves a finding by its Spotify track id too", async () => {
    await seedTrack(db, { logId: "005.1.3B", title: "Rio", trackId: "t-rio" });

    const result = (await toolExecute("get_track")({ idOrLogId: "t-rio" })) as {
      finding: { coordinate?: string };
    };

    expect(result.finding.coordinate).toBe("005.1.3B");
  });

  it("returns found:false for a coordinate he has not logged", async () => {
    const result = await toolExecute("get_track")({ idOrLogId: "999.9.9Z" });

    expect(result).toEqual({ found: false, ok: true });
  });
});

// ── get_random_track ───────────────────────────────────────────────────────────────────

describe("get_random_track", () => {
  it("pulls a certified finding from a non-empty archive", async () => {
    await seedTrack(db, { logId: "006.2.4C", title: "Only One", trackId: "t-only" });

    const result = (await toolExecute("get_random_track")({})) as {
      finding: { coordinate?: string; title: string };
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.finding.title).toBe("Only One");
    expect(result.finding.coordinate).toBe("006.2.4C");
  });

  it("returns found:false from an empty archive", async () => {
    const result = await toolExecute("get_random_track")({});

    expect(result).toEqual({ found: false, ok: true });
  });
});

// ── get_status ─────────────────────────────────────────────────────────────────────────

describe("get_status — the systems check", () => {
  async function seedService(service: string, status: string): Promise<void> {
    const now = new Date().toISOString();

    await db.execute({
      args: [service, status, now, now],
      sql: `insert into service_status (service, status, checked_at, since) values (?, ?, ?, ?)`,
    });
  }

  it("reports the honest unknown when nothing has checked in", async () => {
    const result = (await toolExecute("get_status")({})) as { headline: string; ok: boolean };

    expect(result.ok).toBe(false);
    expect(result.headline).toBe("No system has reported in yet.");
  });

  it("summarizes an all-up cosmos", async () => {
    await seedService("web", "ok");
    await seedService("api", "ok");

    const result = (await toolExecute("get_status")({})) as { headline: string; ok: boolean };

    expect(result.ok).toBe(true);
    expect(result.headline).toBe("All 2 systems are up.");
  });

  it("flags a down system", async () => {
    await seedService("web", "ok");
    await seedService("api", "down");

    const result = (await toolExecute("get_status")({})) as { headline: string; ok: boolean };

    expect(result.ok).toBe(false);
    expect(result.headline).toContain("api down");
  });
});

// ── search_archive ─────────────────────────────────────────────────────────────────────

describe("search_archive — the dig, over the real FTS index", () => {
  beforeEach(async () => {
    await seedTrack(db, {
      artists: ["1991"],
      logId: "024.7.2R",
      title: "Nine Clouds",
      trackId: "certified-1991",
    });
    await seedCatalogueTrack(db, {
      artists: ["Ghost Producer"],
      title: "Rio Catalogue",
      trackId: "uncertified-rio",
    });
  });

  it("returns a certified hit in the findings register, coordinate intact", async () => {
    const result = (await toolExecute("search_archive")({ query: "clouds" })) as {
      catalogue?: unknown[];
      findings: { coordinate?: string; title: string }[];
    };

    expect(result.findings.map((finding) => finding.title)).toEqual(["Nine Clouds"]);
    expect(result.findings[0]?.coordinate).toBe("024.7.2R");
  });

  it("returns an uncertified hit in the unlit catalogue register, no coordinate", async () => {
    const result = (await toolExecute("search_archive")({ query: "rio" })) as {
      catalogue: { coordinate?: string; title: string }[];
      findings?: unknown[];
    };

    expect(result.catalogue.map((row) => row.title)).toEqual(["Rio Catalogue"]);
    expect(result.catalogue[0]?.coordinate).toBeUndefined();
    expect(result.findings ?? []).toEqual([]);
  });

  it("returns an honest empty for a dig that matches nothing", async () => {
    const result = (await toolExecute("search_archive")({ query: "zzqnomatchxx" })) as {
      catalogue?: unknown[];
      findings?: unknown[];
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.findings ?? []).toEqual([]);
    expect(result.catalogue ?? []).toEqual([]);
  });
});

// ── get_artist ─────────────────────────────────────────────────────────────────────────

describe("get_artist — the artist dossier's grounding", () => {
  it("returns a certified artist's findings, resolved name → slug → id", async () => {
    await seedArtist(db, { id: "art-net", name: "Netsky", slug: "netsky" });
    await seedTrack(db, { artists: ["Netsky"], logId: "004.7.2I", title: "Rio", trackId: "t-rio" });
    await linkArtist("t-rio", "art-net");

    const result = (await toolExecute("get_artist")({ name: "Netsky" })) as {
      artist: { findingCount?: number; findings: { coordinate?: string }[]; slug?: string };
    };

    expect(result.artist.slug).toBe("netsky");
    expect(result.artist.findingCount).toBe(1);
    expect(result.artist.findings.map((finding) => finding.coordinate)).toEqual(["004.7.2I"]);
  });

  it("returns the UNLIT entity (name + catalogue, no findings) for a catalogue-only artist", async () => {
    await seedArtist(db, { id: "art-q", name: "Quiet One", slug: "quiet-one" });
    await seedCatalogueTrack(db, { artists: ["Quiet One"], title: "Drift", trackId: "cat-q" });
    await linkArtist("cat-q", "art-q");
    await setAlbum("cat-q", "Far Sectors EP");

    const result = (await toolExecute("get_artist")({ name: "Quiet One" })) as {
      artist: {
        catalogue?: { release?: string; title: string }[];
        findings?: unknown[];
        name?: string;
      };
    };

    expect(result.artist.name).toBe("Quiet One");
    expect(result.artist.catalogue?.map((row) => row.title)).toEqual(["Drift"]);
    expect(result.artist.catalogue?.[0]?.release).toBe("Far Sectors EP");
    // dropEmpty strips the empty findings array — the entity is named, never presented as found.
    expect(result.artist.findings ?? []).toEqual([]);
    expect(result.artist.catalogue?.[0]).not.toHaveProperty("coordinate");
  });

  it("returns found:false for an artist he has never heard of", async () => {
    const result = await toolExecute("get_artist")({ name: "Nobody At All" });

    expect(result).toEqual({ found: false, ok: true });
  });
});

// ── get_label ──────────────────────────────────────────────────────────────────────────

describe("get_label — the label dossier's grounding", () => {
  it("returns a certified label's findings, resolved name → slug → id", async () => {
    await seedTrack(db, {
      artists: ["Nu:Tone"],
      logId: "005.1.3B",
      title: "Better Places",
      trackId: "t-bp",
    });
    // The REAL publish-path minting, so the labels row + tracks.label_id edge are production's.
    await linkTrackToLabel("t-bp", "Hospital Records");

    const result = (await toolExecute("get_label")({ name: "Hospital Records" })) as {
      label: { findingCount?: number; findings: { coordinate?: string }[]; slug?: string };
    };

    expect(result.label.slug).toBe("hospital-records");
    expect(result.label.findingCount).toBe(1);
    expect(result.label.findings.map((finding) => finding.coordinate)).toEqual(["005.1.3B"]);
  });

  it("returns the UNLIT entity (name + catalogue, no findings) for a catalogue-only label", async () => {
    await seedCatalogueTrack(db, {
      artists: ["Some Artist"],
      title: "Debut Cut",
      trackId: "cat-lbl",
    });
    await linkTrackToLabel("cat-lbl", "Empty Imprint");
    await setAlbum("cat-lbl", "Debut EP");

    const result = (await toolExecute("get_label")({ name: "Empty Imprint" })) as {
      label: { catalogue?: { title: string }[]; findings?: unknown[]; name?: string };
    };

    expect(result.label.name).toBe("Empty Imprint");
    expect(result.label.catalogue?.map((row) => row.title)).toEqual(["Debut Cut"]);
    expect(result.label.findings ?? []).toEqual([]);
  });

  it("returns found:false for a label he does not know", async () => {
    const result = await toolExecute("get_label")({ name: "No Such Imprint" });

    expect(result).toEqual({ found: false, ok: true });
  });
});

// ── build_set ──────────────────────────────────────────────────────────────────────────

describe("build_set — the mix chain, ranked by the real engine", () => {
  it("says the archive is thin when a lonely seed has nothing to chain", async () => {
    // Seed FIRST so the depth gate (memoized per isolate) reads this sparse archive fresh.
    await seedTrack(db, { logId: "050.1.1A", title: "Lonely", trackId: "lonely" });
    await setKeyBpm("lonely", "A minor", 174);

    const result = (await toolExecute("build_set")({ seed: "050.1.1A" })) as {
      set: { seed: { coordinate?: string }; steps?: unknown[]; thin?: boolean };
    };

    expect(result.set.seed.coordinate).toBe("050.1.1A");
    expect(result.set.steps ?? []).toEqual([]);
    expect(result.set.thin).toBe(true);
  });

  it("chains same-key candidates off a seed, each with a worded reason and a /mix handoff", async () => {
    await seedTrack(db, { logId: "040.1.1A", title: "Seed", trackId: "seed-t" });
    await setKeyBpm("seed-t", "A minor", 174);
    await seedTrack(db, { logId: "041.1.1A", title: "One", trackId: "cand-1" });
    await setKeyBpm("cand-1", "A minor", 174);
    await seedTrack(db, { logId: "042.1.1A", title: "Two", trackId: "cand-2" });
    await setKeyBpm("cand-2", "A minor", 175);

    const result = (await toolExecute("build_set")({ seed: "040.1.1A" })) as {
      set: {
        seed: { coordinate?: string };
        setUrl?: string;
        steps: { coordinate?: string; reason?: unknown }[];
      };
    };

    expect(result.set.seed.coordinate).toBe("040.1.1A");
    // Both same-key findings mix cleanly out of the seed (the real engine ranked them).
    expect(result.set.steps.length).toBeGreaterThanOrEqual(1);
    expect(
      result.set.steps
        .map((step) => step.coordinate)
        .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["041.1.1A", "042.1.1A"]);
    // Every reason is a worded string (mixReasonLabel), never a numeric score.
    for (const step of result.set.steps) {
      expect(typeof step.reason).toBe("string");
      expect((step.reason as string).length).toBeGreaterThan(0);
    }
    expect(result.set.setUrl).toContain("/mix?set=040.1.1A");
  });

  it("returns found:false when the seed resolves to no logged finding", async () => {
    const result = await toolExecute("build_set")({ seed: "not a real track" });

    expect(result).toEqual({ found: false, ok: true });
  });
});

// ── list_similar_artists ────────────────────────────────────────────────────────────────

describe("list_similar_artists — the neighbours read, over the real precompute", () => {
  it("returns the nearest artist after the similarity sweep runs", async () => {
    // Two artists with embedded certified findings; their vectors are close, so each is the other's
    // neighbour once rankArtists precomputes the edges (the real vector path, not a mock).
    await seedArtist(db, { id: "sa-1", name: "Koven", slug: "koven" });
    await seedTrack(db, { artists: ["Koven"], logId: "060.1.1A", title: "K", trackId: "k-t" });
    await linkArtist("k-t", "sa-1");
    await setKeyBpm("k-t", "A minor", 174);
    await embed("k-t", axis(0));

    await seedArtist(db, { id: "sa-2", name: "Metrik", slug: "metrik" });
    await seedTrack(db, { artists: ["Metrik"], logId: "061.1.1A", title: "M", trackId: "m-t" });
    await linkArtist("m-t", "sa-2");
    await setKeyBpm("m-t", "A minor", 174);
    await embed("m-t", blend(axis(0), axis(1), 0.1));

    await rankArtists(100);

    const result = (await toolExecute("list_similar_artists")({ name: "Koven" })) as {
      of: { name?: string; slug?: string };
      similar: { slug: string }[];
    };

    expect(result.of).toMatchObject({ name: "Koven", slug: "koven" });
    expect(result.similar.map((artist) => artist.slug)).toContain("metrik");
  });

  it("returns found:false for an artist he has not logged", async () => {
    const result = await toolExecute("list_similar_artists")({ name: "Nobody At All" });

    expect(result).toEqual({ found: false, ok: true });
  });

  it("returns an honest empty list for a resolved artist with no neighbours yet", async () => {
    await seedArtist(db, { id: "sa-solo", name: "Solo Act", slug: "solo-act" });

    const result = (await toolExecute("list_similar_artists")({ name: "Solo Act" })) as {
      ok: boolean;
      similar: unknown[];
    };

    expect(result.ok).toBe(true);
    expect(result.similar).toEqual([]);
  });
});

// ── the catalogue browse tools ───────────────────────────────────────────────────────────

describe("list_album_catalogue / list_artist_catalogue / list_label_catalogue", () => {
  it("list_album_catalogue lists an album's uncertified tracks, catalogue-only", async () => {
    await seedCatalogueTrack(db, { artists: ["Netsky"], title: "Iron Heart", trackId: "cat-ih" });
    await linkTrackToAlbum("cat-ih", "Colours");

    const result = (await toolExecute("list_album_catalogue")({ name: "Colours" })) as {
      catalogue: { release?: string; title: string }[];
      findings: unknown[];
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.catalogue.map((row) => row.title)).toEqual(["Iron Heart"]);
    expect(result.catalogue[0]?.release).toBe("Colours");
  });

  it("list_artist_catalogue flattens the artist's grouped catalogue", async () => {
    await seedArtist(db, { id: "art-net", name: "Netsky", slug: "netsky" });
    await seedCatalogueTrack(db, { artists: ["Netsky"], title: "Come Alive", trackId: "cat-ca" });
    await linkArtist("cat-ca", "art-net");
    await setAlbum("cat-ca", "Colours");

    const result = (await toolExecute("list_artist_catalogue")({ name: "Netsky" })) as {
      catalogue: { release?: string; title: string }[];
      findings: unknown[];
    };

    expect(result.findings).toEqual([]);
    expect(result.catalogue.map((row) => row.title)).toEqual(["Come Alive"]);
    expect(result.catalogue[0]?.release).toBe("Colours");
  });

  it("list_label_catalogue flattens the label's grouped catalogue, carrying the label as context", async () => {
    await seedCatalogueTrack(db, { artists: ["Netsky"], title: "Iron Heart", trackId: "cat-lih" });
    await linkTrackToLabel("cat-lih", "Hospital Records");
    await setAlbum("cat-lih", "Colours");

    const result = (await toolExecute("list_label_catalogue")({ name: "Hospital Records" })) as {
      catalogue: { label?: string; title: string }[];
    };

    expect(result.catalogue.map((row) => row.title)).toEqual(["Iron Heart"]);
    expect(result.catalogue[0]?.label).toBe("Hospital Records");
  });

  it("an unresolved name is the honest empty catalogue bucket, never an error", async () => {
    for (const name of [
      "list_album_catalogue",
      "list_artist_catalogue",
      "list_label_catalogue",
    ] as const) {
      const result = await toolExecute(name)({ name: "Nothing Of His" });

      expect(result, name).toEqual({
        catalogue: [],
        findings: [],
        ok: true,
        page: 1,
        pageCount: 1,
      });
    }
  });
});

// ── submit_track (a write) ───────────────────────────────────────────────────────────────

describe("submit_track — the queue write", () => {
  const TRACK_ID = "4cOdK2wGLETKBW3PvgPWqT";
  const SPOTIFY_URL = `https://open.spotify.com/track/${TRACK_ID}`;

  function stubSpotify(): void {
    searchTrackCandidates.mockResolvedValue([
      {
        album: "Some Album",
        artists: ["Someone"],
        artworkUrl: "https://img.example/cover.jpg",
        durationMs: 200_000,
        id: TRACK_ID,
        spotifyArtistIds: [],
        spotifyUrl: SPOTIFY_URL,
        title: "Submitted Banger",
      },
    ]);
    fetchTrackMetadata.mockResolvedValue({
      album: "Some Album",
      albumImageUrl: "https://img.example/cover.jpg",
      artists: ["Someone"],
      durationMs: 200_000,
      spotifyArtistIds: [],
      spotifyUri: `spotify:track:${TRACK_ID}`,
      spotifyUrl: SPOTIFY_URL,
      title: "Submitted Banger",
      trackId: TRACK_ID,
    });
  }

  it("drops a submission in the queue and persists a real row", async () => {
    stubSpotify();

    const result = (await toolExecute(
      "submit_track",
      ipRequest(),
    )({ spotifyUrl: SPOTIFY_URL })) as {
      ok: boolean;
      submission: { title: string };
    };

    expect(result.ok).toBe(true);
    expect(result.submission.title).toBe("Submitted Banger");
    // The row actually landed in the submissions table (the DB half really ran).
    const rows = await db.execute("select spotify_track_id, status from submissions");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.spotify_track_id).toBe(TRACK_ID);
    expect(rows.rows[0]?.status).toBe("pending");
  });

  it("throws when Spotify matches no track", async () => {
    searchTrackCandidates.mockResolvedValue([]);

    await expect(
      toolExecute("submit_track", ipRequest())({ spotifyUrl: SPOTIFY_URL }),
    ).rejects.toThrow(/No track matched/);
  });

  it("throws without a Spotify URL", async () => {
    await expect(toolExecute("submit_track", ipRequest())({})).rejects.toThrow(
      /Spotify track URL is required/,
    );
  });

  it("throws without a request context (the writes need one)", async () => {
    await expect(toolExecute("submit_track")({ spotifyUrl: SPOTIFY_URL })).rejects.toThrow(
      /request context is required/,
    );
  });
});

// ── subscribe_newsletter (a write) ───────────────────────────────────────────────────────

describe("subscribe_newsletter — the newsletter write", () => {
  it("boards a valid email onto the segment", async () => {
    const result = await toolExecute(
      "subscribe_newsletter",
      ipRequest(),
    )({
      email: "fan@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(addContactToSegment).toHaveBeenCalledWith("fan@example.com");
  });

  it("throws on an invalid email, and never touches the segment", async () => {
    await expect(
      toolExecute("subscribe_newsletter", ipRequest())({ email: "not-an-email" }),
    ).rejects.toThrow();
    expect(addContactToSegment).not.toHaveBeenCalled();
  });

  it("throws without a request context", async () => {
    await expect(toolExecute("subscribe_newsletter")({ email: "fan@example.com" })).rejects.toThrow(
      /request context is required/,
    );
  });
});
