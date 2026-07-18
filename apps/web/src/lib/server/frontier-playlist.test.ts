import { beforeEach, describe, expect, it, vi } from "vitest";

// FLUNCLE'S FRONTIER — the per-user public playlist's contract (E2): the DEFAULT-DENY
// kill switch (no Spotify call when closed), create-once, the URI order (findings first,
// de-duped), the personalized description, the mirror guard (unchanged ⇒ zero writes),
// the rolling daily mint cap, the weekly refresh's iteration, and the cover upload leg's
// clean scope-failure degradation. Every Spotify path is mocked — this pins BEHAVIOUR,
// not the vendor.

type FrontierRow = {
  cover_uploaded_at: null | string;
  created_at: string;
  last_synced_at: null | string;
  last_uri_hash: null | string;
  playlist_id: string;
  user_id: string;
};

type UserRow = {
  created_at: number;
  crew_number: null | number;
  display_username: null | string;
  email: null | string;
  email_verified: number;
  handle?: null | string;
  id: string;
  image: null | string;
  name: null | string;
  username: null | string;
};

/** A frozen edition captured by the fake `db.batch` — proves the snapshot hook (A2). */
type CapturedEdition = {
  createdAt: string;
  id: string;
  tracks: Array<Record<string, unknown>>;
  userId: string;
};

/** A rec row rich enough to freeze — the snapshot writer reads the whole thing (A2). */
type RecRow = {
  artists?: string[];
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  logId?: string;
  spotifyUri?: string;
  spotifyUrl?: string;
  title?: string;
  trackId?: string;
};

const settings = new Map<string, string>();
const rows = new Map<string, FrontierRow>();
const userRows = new Map<string, UserRow>();
const editions: CapturedEdition[] = [];
const batches: Array<{ args: unknown[]; sql: string }[]> = [];
const spotifyCalls: { init?: RequestInit; path: string }[] = [];
let recs: { catalogue: RecRow[]; findings: RecRow[] } | Response = { catalogue: [], findings: [] };
let failFetch = false;

vi.mock("./settings", () => ({
  getSetting: vi.fn((key: string) => Promise.resolve(settings.get(key))),
  setSetting: vi.fn((key: string, value: string) => {
    settings.set(key, value);

    return Promise.resolve();
  }),
}));

vi.mock("./log", () => ({ logEvent: vi.fn() }));

vi.mock("./recommendations", () => ({
  listRecommendations: vi.fn(() => Promise.resolve(recs)),
}));

vi.mock("./spotify", () => ({
  getSpotifyAccessToken: vi.fn(() => Promise.resolve("token")),
  spotifyFetch: vi.fn((path: string, _token: string, init?: RequestInit) => {
    spotifyCalls.push({ init, path });

    if (failFetch) {
      return Promise.reject(new Error("spotify down"));
    }

    // The create — `POST /me/playlists` (the Feb-2026 migration endpoint; the
    // retired `/users/{id}/playlists` 403s live, so a mock for it would pin a bug).
    if (path === "/me/playlists") {
      return Promise.resolve(new Response(JSON.stringify({ id: "pl-new" })));
    }

    return Promise.resolve(new Response("{}"));
  }),
}));

vi.mock("./db", () => ({
  getDb: vi.fn(() => Promise.resolve({ batch: fakeBatch, execute: fakeExecute })),
  typedRow: (r: unknown[]) => r[0],
  typedRows: (r: unknown[]) => r,
}));

// The real `frontier-editions` INSERT builder runs — only the DB is faked. So the batch
// carries the actual parent/child statements A2 folds in, and `fakeBatch` captures them.
vi.mock("./artists", () => ({ parseArtistsJson: (s: string) => JSON.parse(s) }));

/**
 * The fake `db.batch(_, "write")` A2's two real-write branches now use. It captures the
 * frozen-edition inserts (parent + children) into `editions` and delegates the playlist
 * write to `fakeExecute`, so a test can assert exactly one edition + its frozen rows land
 * atomically. `unchanged`/`switch_off` never reach a batch, so they capture nothing.
 */
function fakeBatch(statements: { args: unknown[]; sql: string }[]): Promise<unknown[]> {
  batches.push(statements);

  for (const statement of statements) {
    if (statement.sql.startsWith("insert into frontier_editions ")) {
      editions.push({
        createdAt: String(statement.args[3]),
        id: String(statement.args[0]),
        tracks: [],
        userId: String(statement.args[1]),
      });
    } else if (statement.sql.startsWith("insert into frontier_edition_tracks")) {
      const [
        editionId,
        position,
        trackId,
        logId,
        title,
        artistsText,
        coverUrl,
        spotifyUri,
        spotifyUrl,
        bpm,
        key,
        durationMs,
        slot,
      ] = statement.args;
      editions
        .find((edition) => edition.id === String(editionId))
        ?.tracks.push({
          artistsText,
          bpm,
          coverUrl,
          durationMs,
          key,
          logId,
          position,
          slot,
          spotifyUri,
          spotifyUrl,
          title,
          trackId,
        });
    } else {
      void fakeExecute(statement);
    }
  }

  return Promise.resolve([]);
}

// A minimal in-memory stand-in for the exact statements frontier-playlist.ts runs.
function fakeExecute({
  args,
  sql,
}: {
  args: unknown[];
  sql: string;
}): Promise<{ rows: unknown[] }> {
  if (sql.includes("cover_uploaded_at is null")) {
    const limit = Number(args[0]);
    const targets = [...rows.values()]
      .filter((row) => row.cover_uploaded_at === null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((row) => {
        const user = userRows.get(row.user_id);

        return {
          crew_number: user?.crew_number ?? null,
          handle: user?.display_username ?? user?.username ?? null,
          playlist_id: row.playlist_id,
          user_id: row.user_id,
        };
      });

    return Promise.resolve({ rows: targets });
  }

  if (sql.includes("from user_frontier_playlists f") && sql.includes('join "user" u')) {
    const limit = Number(args[0]);
    const users = [...rows.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => userRows.get(row.user_id))
      .filter((user): user is UserRow => Boolean(user))
      .slice(0, limit);

    return Promise.resolve({ rows: users });
  }

  if (sql.includes("count(*) as mints")) {
    const cutoff = String(args[0]);
    const mints = [...rows.values()].filter((row) => row.created_at >= cutoff).length;

    return Promise.resolve({ rows: [{ mints }] });
  }

  if (sql.includes("from user_frontier_playlists") && sql.includes("where user_id = ? limit 1")) {
    const row = rows.get(String(args[0]));

    return Promise.resolve({ rows: row ? [row] : [] });
  }

  if (sql.startsWith("insert into user_frontier_playlists")) {
    const [userId, playlistId, createdAt, lastSyncedAt, lastUriHash] = args.map(String);
    rows.set(userId ?? "", {
      cover_uploaded_at: null,
      created_at: createdAt ?? "",
      last_synced_at: lastSyncedAt ?? null,
      last_uri_hash: lastUriHash ?? null,
      playlist_id: playlistId ?? "",
      user_id: userId ?? "",
    });

    return Promise.resolve({ rows: [] });
  }

  if (sql.includes("set last_synced_at = ?")) {
    const [lastSyncedAt, lastUriHash, userId] = args.map(String);
    const row = rows.get(userId ?? "");

    if (row) {
      row.last_synced_at = lastSyncedAt ?? null;
      row.last_uri_hash = lastUriHash ?? null;
    }

    return Promise.resolve({ rows: [] });
  }

  if (sql.includes("set cover_uploaded_at = ?")) {
    const [coverUploadedAt, userId] = args.map(String);
    const row = rows.get(userId ?? "");

    if (row) {
      row.cover_uploaded_at = coverUploadedAt ?? null;
    }

    return Promise.resolve({ rows: [] });
  }

  return Promise.resolve({ rows: [] });
}

function makeUser(overrides: Partial<UserRow> & { id: string }): {
  createdAt: string;
  crewNumber?: number;
  displayUsername?: string;
  email: string;
  emailVerified: boolean;
  id: string;
  name: string;
  username?: string;
} {
  return {
    createdAt: new Date().toISOString(),
    crewNumber: overrides.crew_number ?? undefined,
    displayUsername: overrides.display_username ?? undefined,
    email: overrides.email ?? "u@fluncle.com",
    emailVerified: (overrides.email_verified ?? 1) === 1,
    id: overrides.id,
    name: overrides.name ?? "A User",
    username: overrides.username ?? undefined,
  };
}

/** Seed a stored playlist row + its user (for refresh/cover/cap tests). */
function seedRow(row: Partial<FrontierRow> & { playlist_id: string; user_id: string }): void {
  rows.set(row.user_id, {
    cover_uploaded_at: row.cover_uploaded_at ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
    last_synced_at: row.last_synced_at ?? null,
    last_uri_hash: row.last_uri_hash ?? null,
    playlist_id: row.playlist_id,
    user_id: row.user_id,
  });
  userRows.set(row.user_id, {
    created_at: Date.now(),
    crew_number: 7,
    display_username: null,
    email: "u@fluncle.com",
    email_verified: 1,
    id: row.user_id,
    image: null,
    name: "A User",
    username: `user-${row.user_id}`,
  });
}

function uri(id: string): string {
  return `spotify:track:${id}`;
}

beforeEach(() => {
  settings.clear();
  rows.clear();
  userRows.clear();
  editions.length = 0;
  batches.length = 0;
  spotifyCalls.length = 0;
  recs = { catalogue: [], findings: [] };
  failFetch = false;
});

describe("the kill switch (default-deny)", () => {
  it("returns switch_off with NO Spotify call when the flag is unset", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");
    const { listRecommendations } = await import("./recommendations");

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(result).toEqual({ ok: true, status: "switch_off" });
    expect(spotifyCalls).toEqual([]);
    // The engine isn't even consulted when the switch is closed.
    expect(listRecommendations).not.toHaveBeenCalled();
  });

  it('only the literal string "true" opens minting', async () => {
    const { isFrontierMintingOpen } = await import("./frontier-playlist");

    settings.set("frontier.minting", "false");
    expect(await isFrontierMintingOpen()).toBe(false);
    settings.set("frontier.minting", "1");
    expect(await isFrontierMintingOpen()).toBe(false);
    settings.set("frontier.minting", "true");
    expect(await isFrontierMintingOpen()).toBe(true);
  });

  it("setFrontierMintingOpen round-trips through the same read (the switch ops' seam)", async () => {
    const { isFrontierMintingOpen, setFrontierMintingOpen } = await import("./frontier-playlist");

    await setFrontierMintingOpen(true);
    expect(await isFrontierMintingOpen()).toBe(true);

    await setFrontierMintingOpen(false);
    expect(await isFrontierMintingOpen()).toBe(false);

    // Closed writes the literal "false", never a deleted row — a re-open is one flip.
    expect(settings.get("frontier.minting")).toBe("false");
  });
});

describe("mint (create-once) + the URI order", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("creates a PUBLIC playlist once, findings first then catalogue, de-duped, and is idempotent", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = {
      catalogue: [{ spotifyUri: uri("cat1") }, { spotifyUri: uri("dup") }],
      // `dup` also appears in catalogue → must be de-duped, keeping the findings slot.
      findings: [{ spotifyUri: uri("find1") }, { spotifyUri: uri("dup") }],
    };

    const first = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "alice" }));

    expect(first).toMatchObject({ ok: true, status: "minted" });
    expect(first).toMatchObject({ playlistUrl: "https://open.spotify.com/playlist/pl-new" });

    const create = spotifyCalls.find((call) => call.path === "/me/playlists");
    expect(JSON.parse((create?.init?.body as string) ?? "{}")).toMatchObject({ public: true });

    const put = spotifyCalls.find((call) => call.init?.method === "PUT");
    expect(JSON.parse((put?.init?.body as string) ?? "{}").uris).toEqual([
      uri("find1"),
      uri("dup"),
      uri("cat1"),
    ]);

    // A second mint with the SAME recs is a no-op refresh — one create total.
    spotifyCalls.length = 0;
    const second = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "alice" }));

    expect(second).toMatchObject({ status: "unchanged" });
    expect(spotifyCalls).toEqual([]);
  });

  it("personalizes the description with the @handle (sentence case, no em dashes, ≤300)", async () => {
    const { frontierDescription } = await import("./frontier-playlist");

    const desc = frontierDescription(makeUser({ id: "u1", username: "alice" }));

    expect(desc).toBe(
      "Dug for @alice from the far side of the archive. Refreshed weekly. fluncle.com",
    );
    expect(desc.length).toBeLessThanOrEqual(300);
    expect(desc).not.toContain("—");
    // A legacy account with no handle falls back to a plain noun, never a bare "@".
    expect(frontierDescription(makeUser({ id: "u2" }))).toContain("Dug for the crew ");
  });
});

describe("refresh (the mirror guard)", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("an unchanged item list skips the PUT entirely (zero Spotify calls)", async () => {
    const { hashUrisForTest, mintOrRefreshFrontierPlaylist } = await importWithHash();

    recs = { catalogue: [{ spotifyUri: uri("cat1") }], findings: [{ spotifyUri: uri("find1") }] };
    seedRow({
      last_uri_hash: hashUrisForTest([uri("find1"), uri("cat1")]),
      playlist_id: "pl-existing",
      user_id: "u1",
    });

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));

    expect(result).toMatchObject({ playlistUrl: expect.any(String), status: "unchanged" });
    expect(spotifyCalls).toEqual([]);
  });

  it("a changed item list full-replaces and advances the stored hash", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = { catalogue: [{ spotifyUri: uri("cat2") }], findings: [{ spotifyUri: uri("find1") }] };
    seedRow({ last_uri_hash: "stale-hash", playlist_id: "pl-existing", user_id: "u1" });

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));

    expect(result).toMatchObject({ status: "refreshed" });
    const put = spotifyCalls.find(
      (call) => call.path === "/playlists/pl-existing/items" && call.init?.method === "PUT",
    );
    expect(JSON.parse((put?.init?.body as string) ?? "{}").uris).toEqual([
      uri("find1"),
      uri("cat2"),
    ]);
    expect(rows.get("u1")?.last_uri_hash).not.toBe("stale-hash");
    expect(rows.get("u1")?.last_synced_at).not.toBeNull();
  });

  it("a Spotify failure reports { ok: false }, never throws, and does NOT advance the hash", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = { catalogue: [], findings: [{ spotifyUri: uri("find1") }] };
    seedRow({ last_uri_hash: "stale-hash", playlist_id: "pl-existing", user_id: "u1" });
    failFetch = true;

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(result).toMatchObject({ ok: false });
    expect(rows.get("u1")?.last_uri_hash).toBe("stale-hash");
  });
});

describe("the edition snapshot (A2)", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  const richFinding: RecRow = {
    artists: ["Finding Artist", "Featured"],
    bpm: 174,
    durationMs: 270_000,
    imageUrl: "https://covers.example/find1.jpg",
    key: "A minor",
    logId: "001.1.1A",
    spotifyUri: uri("find1"),
    spotifyUrl: "https://open.spotify.com/track/find1",
    title: "Finding One",
    trackId: "track-find1",
  };
  const richCatalogue: RecRow = {
    artists: ["Catalogue Artist"],
    spotifyUri: uri("cat1"),
    spotifyUrl: "https://open.spotify.com/track/cat1",
    title: "Catalogue One",
    trackId: "track-cat1",
  };

  it("a MINTED sync writes exactly one edition + its frozen rows in ONE batch (de-duped PUT order, with readouts)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    // A catalogue rec sharing the finding's Spotify URI → the frozen list must de-dupe it,
    // keeping the finding slot, exactly like the PUT.
    const dupCatalogue: RecRow = { spotifyUri: uri("find1"), title: "Dup", trackId: "track-dup" };
    recs = { catalogue: [richCatalogue, dupCatalogue], findings: [richFinding] };

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "alice" }));

    expect(result).toMatchObject({ status: "minted" });

    // ONE batch — the playlist insert AND the edition inserts committed together.
    expect(batches).toHaveLength(1);
    const only = batches[0] ?? [];
    expect(only.some((s) => s.sql.startsWith("insert into user_frontier_playlists"))).toBe(true);
    expect(only.some((s) => s.sql.startsWith("insert into frontier_editions "))).toBe(true);

    // Exactly one edition, frozen in the de-duped PUT order (find1, cat1 — the dup dropped).
    expect(editions).toHaveLength(1);
    const edition = editions[0];
    expect(edition?.userId).toBe("u1");
    expect(edition?.tracks.map((t) => t.trackId)).toEqual(["track-find1", "track-cat1"]);
    expect(edition?.tracks.map((t) => t.position)).toEqual([1, 2]);

    // The finding slot carries its coordinate + frozen readout chips + JSON artists.
    const finding = edition?.tracks[0];
    expect(finding?.slot).toBe("finding");
    expect(finding?.logId).toBe("001.1.1A");
    expect(finding?.spotifyUri).toBe(uri("find1"));
    expect(finding?.spotifyUrl).toBe("https://open.spotify.com/track/find1");
    expect(finding?.coverUrl).toBe("https://covers.example/find1.jpg");
    expect(finding?.artistsText).toBe(JSON.stringify(["Finding Artist", "Featured"]));
    expect(finding?.bpm).toBe(174);
    expect(finding?.key).toBe("A minor");
    expect(finding?.durationMs).toBe(270_000);

    // The catalogue row stays coordinate-less; readouts it cannot back freeze as null.
    const catalogue = edition?.tracks[1];
    expect(catalogue?.slot).toBe("catalogue");
    expect(catalogue?.logId).toBeNull();
    expect(catalogue?.bpm).toBeNull();
    expect(catalogue?.key).toBeNull();
    expect(catalogue?.durationMs).toBeNull();
  });

  it("a REFRESHED sync (changed list) writes exactly one edition in ONE batch", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    recs = { catalogue: [richCatalogue], findings: [richFinding] };
    seedRow({ last_uri_hash: "stale-hash", playlist_id: "pl-existing", user_id: "u1" });

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));

    expect(result).toMatchObject({ status: "refreshed" });
    expect(batches).toHaveLength(1);
    expect(editions).toHaveLength(1);
    expect(editions[0]?.tracks.map((t) => t.trackId)).toEqual(["track-find1", "track-cat1"]);
    // The batch folds the hash advance AND the edition together (atomic).
    expect((batches[0] ?? []).some((s) => s.sql.includes("set last_synced_at = ?"))).toBe(true);
  });

  it("an UNCHANGED sync writes NO edition (and issues no batch at all)", async () => {
    const { hashUrisForTest, mintOrRefreshFrontierPlaylist } = await importWithHash();

    recs = { catalogue: [richCatalogue], findings: [richFinding] };
    seedRow({
      last_uri_hash: hashUrisForTest([uri("find1"), uri("cat1")]),
      playlist_id: "pl-existing",
      user_id: "u1",
    });

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1", username: "bob" }));

    expect(result).toMatchObject({ status: "unchanged" });
    expect(batches).toEqual([]);
    expect(editions).toEqual([]);
  });

  it("uses listRecommendations with excludeRecent:true (the novelty switch)", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");
    const { listRecommendations } = await import("./recommendations");

    recs = { catalogue: [], findings: [richFinding] };
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u1" }));

    expect(listRecommendations).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }), {
      excludeRecent: true,
    });
  });
});

describe("the rolling daily mint cap", () => {
  beforeEach(() => settings.set("frontier.minting", "true"));

  it("blocks a NEW mint once the cap is spent inside the window (no create call)", async () => {
    const { FRONTIER_DAILY_MINT_CAP, mintOrRefreshFrontierPlaylist } =
      await import("./frontier-playlist");

    const now = Date.now();
    for (let index = 0; index < FRONTIER_DAILY_MINT_CAP; index += 1) {
      seedRow({
        created_at: new Date(now - 1000).toISOString(),
        playlist_id: `pl-${index}`,
        user_id: `seeded-${index}`,
      });
    }
    recs = { catalogue: [], findings: [{ spotifyUri: uri("find1") }] };

    const result = await mintOrRefreshFrontierPlaylist(makeUser({ id: "new-user" }), now);

    expect(result).toEqual({ ok: false, reason: "mint_cap_reached" });
    expect(spotifyCalls.some((call) => call.path === "/me/playlists")).toBe(false);
  });
});

describe("refreshAllFrontierPlaylists (the weekly sweep's engine)", () => {
  it("returns switchOff and touches nothing when the switch is closed", async () => {
    const { refreshAllFrontierPlaylists } = await import("./frontier-playlist");

    seedRow({ playlist_id: "pl-1", user_id: "u1" });

    const result = await refreshAllFrontierPlaylists(500);

    expect(result.switchOff).toBe(true);
    expect(spotifyCalls).toEqual([]);
  });

  it("iterates every minted playlist and tallies refreshed / unchanged / failed", async () => {
    settings.set("frontier.minting", "true");
    const { hashUrisForTest, refreshAllFrontierPlaylists } = await importWithHash();

    recs = { catalogue: [], findings: [{ spotifyUri: uri("find1") }] };
    // u1: unchanged (hash matches). u2: changed (stale hash → refreshed).
    seedRow({
      created_at: "2026-01-01T00:00:00.000Z",
      last_uri_hash: hashUrisForTest([uri("find1")]),
      playlist_id: "pl-1",
      user_id: "u1",
    });
    seedRow({
      created_at: "2026-01-02T00:00:00.000Z",
      last_uri_hash: "stale",
      playlist_id: "pl-2",
      user_id: "u2",
    });

    const result = await refreshAllFrontierPlaylists(500);

    expect(result).toMatchObject({ failed: 0, refreshed: 1, total: 2, unchanged: 1 });
  });
});

describe("putFrontierCover (the INERT-until-scope upload leg)", () => {
  it("degrades cleanly on a 403 missing scope — stamps nothing", async () => {
    const { putFrontierCover } = await import("./frontier-playlist");

    seedRow({ playlist_id: "pl-1", user_id: "u1" });
    const fetchMock = vi.fn(() => Promise.resolve(new Response("no scope", { status: 403 })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await putFrontierCover("u1", "pl-1", "BASE64");

    expect(result).toEqual({ reason: "missing_scope", uploaded: false });
    expect(rows.get("u1")?.cover_uploaded_at).toBeNull();

    vi.unstubAllGlobals();
  });

  it("stamps cover_uploaded_at on a 200", async () => {
    const { putFrontierCover } = await import("./frontier-playlist");

    seedRow({ playlist_id: "pl-1", user_id: "u1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 200 }))),
    );

    const result = await putFrontierCover("u1", "pl-1", "BASE64");

    expect(result).toEqual({ uploaded: true });
    expect(rows.get("u1")?.cover_uploaded_at).not.toBeNull();

    vi.unstubAllGlobals();
  });
});

/**
 * Re-import the module AND expose its private `hashUris` by recomputing it the same way
 * (sha256 of the joined URI list), so a test can seed a row whose stored hash matches the
 * desired list exactly — proving the mirror guard without reaching into the module.
 */
async function importWithHash() {
  const mod = await import("./frontier-playlist");
  const { createHash } = await import("node:crypto");

  return {
    ...mod,
    hashUrisForTest: (uris: string[]) => createHash("sha256").update(uris.join(",")).digest("hex"),
  };
}

describe("the retired create endpoint (the Feb-2026 Spotify migration)", () => {
  it("never calls /users/{id}/playlists — it 403s live since 2026-03-09", async () => {
    const { mintOrRefreshFrontierPlaylist } = await import("./frontier-playlist");

    settings.set("frontier.minting", "true");
    recs = { catalogue: [{ spotifyUri: uri("cat1") }], findings: [] };
    await mintOrRefreshFrontierPlaylist(makeUser({ id: "u-endpoint" }));

    expect(spotifyCalls.some((call) => call.path.startsWith("/users/"))).toBe(false);
    expect(spotifyCalls.some((call) => call.path === "/me")).toBe(false);
  });
});
