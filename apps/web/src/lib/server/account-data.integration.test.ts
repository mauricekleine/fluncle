import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PublicUser } from "./public-auth";
import {
  createIntegrationDb,
  rowCount,
  seedSubmission,
  seedTrack,
  seedUser,
} from "./integration-db";

// REAL-SQL integration tests for the /me account paths. Instead of mocking the
// DB-write function (which never exercises the actual SQL, data-scoping, or
// schema), we point `getDb()` at an in-memory libSQL database with the generated
// migrations applied, then drive the REAL query functions in account-data.ts.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
  };
});

function publicUser(id: string): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: `${id}@example.com`,
    emailVerified: false,
    id,
    username: id,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("deleteAccount (real SQL via accountDeletionStatements)", () => {
  // Seed a user with a row in EVERY table the deletion touches, then assert the
  // post-state of all of them — not just the two the old mock asserted.
  async function seedFullUser(userId: string, email: string): Promise<void> {
    const trackId = `track-${userId}-0000000000`;
    const logId = `log-${userId}`;

    await seedUser(db, { email, id: userId, username: userId });
    await seedTrack(db, { logId, trackId });

    const now = new Date().toISOString();

    await db.batch([
      {
        args: [`sess-${userId}`, userId, `tok-${userId}`, now, now, now],
        sql: `insert into session (id, user_id, token, expires_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [`acct-${userId}`, userId, "spotify-acct", "spotify", now, now],
        sql: `insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [`ver-${userId}`, email, "code", now, now, now],
        sql: `insert into verification (id, identifier, value, expires_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [`sf-${userId}`, userId, trackId, logId, now],
        sql: `insert into user_saved_findings (id, user_id, track_id, log_id, saved_at)
          values (?, ?, ?, ?, ?)`,
      },
      {
        args: [`ss-${userId}`, userId, `A set`, "4iV5W9uYEdYUVa79Axb7Rh", null, now, now],
        sql: `insert into user_saved_sets
          (id, user_id, name, set_tokens, taste, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [userId, JSON.stringify({ keyNotation: "camelot" }), now],
        sql: `insert into user_preferences (user_id, preferences, updated_at)
          values (?, ?, ?)`,
      },
      {
        args: [`gc-${userId}`, userId, trackId, logId, now, now, "web"],
        sql: `insert into user_galaxy_collections
          (id, user_id, track_id, log_id, first_collected_at, last_collected_at, source_surface)
          values (?, ?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [userId, now, now],
        sql: `insert into user_galaxy_state (user_id, created_at, updated_at)
          values (?, ?, ?)`,
      },
      {
        args: [`push-tok-${userId}`, userId, "ios", now, now],
        sql: `insert into push_tokens (token, user_id, platform, created_at, last_seen_at)
          values (?, ?, ?, ?, ?)`,
      },
    ]);

    await seedSubmission(db, {
      id: `sub-${userId}`,
      spotifyTrackId: trackId,
      status: "pending",
      userId,
    });
  }

  it("clears every per-user table, anonymizes submissions, and marks the user deleted", async () => {
    const { deleteAccount } = await import("./account-data");

    await seedFullUser("user-A", "a@example.com");

    const result = await deleteAccount(publicUser("user-A"));

    expect(result.ok).toBe(true);

    // 1. Hard-deleted per-user tables are now empty for this user.
    for (const table of [
      "user_saved_findings",
      "user_saved_sets",
      "user_preferences",
      "user_galaxy_collections",
      "user_galaxy_state",
      "push_tokens",
      "session",
      "account",
    ]) {
      expect(await rowCount(db, table), `${table} should be cleared`).toBe(0);
    }

    // 2. Verification rows for the user's email are gone.
    expect(await rowCount(db, "verification")).toBe(0);

    // 3. Submissions are ANONYMIZED, not hard-deleted: the row survives with
    //    user_id = null (kept as review history).
    const subs = await db.execute("select id, user_id from submissions");
    expect(subs.rows.length).toBe(1);
    expect(subs.rows[0]?.user_id).toBeNull();

    // 4. The user row is marked-deleted + anonymized, NOT dropped.
    const userRow = await db.execute({
      args: ["user-A"],
      sql: `select status, deleted_at, username, display_username, email, name, image
        from "user" where id = ?`,
    });
    expect(userRow.rows.length).toBe(1);
    const row = userRow.rows[0];
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.username).toBeNull();
    expect(row?.display_username).toBeNull();
    expect(row?.email).toBe("deleted-user-A@fluncle.invalid");
    expect(row?.name).toBe("Deleted account");
    expect(row?.image).toBeNull();

    // 5. A completed deletion request is recorded.
    const requests = await db.execute(
      `select status, mode, summary_json from user_deletion_requests where user_id = 'user-A'`,
    );
    expect(requests.rows.length).toBe(1);
    expect(requests.rows[0]?.status).toBe("completed");
    expect(requests.rows[0]?.mode).toBe("delete");
  });

  it("does not touch a second user's data (scoped deletes)", async () => {
    const { deleteAccount } = await import("./account-data");

    await seedFullUser("user-A", "a@example.com");
    await seedFullUser("user-B", "b@example.com");

    await deleteAccount(publicUser("user-A"));

    // User B's rows survive untouched.
    const bSaved = await db.execute(
      `select count(*) as n from user_saved_findings where user_id = 'user-B'`,
    );
    expect(Number(bSaved.rows[0]?.n)).toBe(1);

    const bSets = await db.execute(
      `select count(*) as n from user_saved_sets where user_id = 'user-B'`,
    );
    expect(Number(bSets.rows[0]?.n)).toBe(1);

    const bUser = await db.execute({
      args: ["user-B"],
      sql: `select status, email from "user" where id = ?`,
    });
    expect(bUser.rows[0]?.status).toBe("active");
    expect(bUser.rows[0]?.email).toBe("b@example.com");

    // Both submissions survive; only A's is anonymized.
    const subs = await db.execute("select user_id from submissions order by id");
    expect(subs.rows.map((r) => r.user_id)).toEqual([null, "user-B"]);
  });
});

describe("/me cross-user data scoping (real SQL, two seeded users)", () => {
  const userA = "user-A";
  const userB = "user-B";

  beforeEach(async () => {
    await seedUser(db, { email: "a@example.com", id: userA, username: "aaa" });
    await seedUser(db, { email: "b@example.com", id: userB, username: "bbb" });
    await seedTrack(db, { logId: "log-shared", trackId: "track-shared-00000000" });
  });

  it("getAccountExport: A cannot read B's export by guessing its id", async () => {
    const { getAccountExport } = await import("./account-data");

    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();

    await db.execute({
      args: ["export-of-B", userB, now, now, expires, "completed"],
      sql: `insert into user_data_exports
        (id, user_id, requested_at, completed_at, expires_at, status)
        values (?, ?, ?, ?, ?, ?)`,
    });

    // B reads its own export: returned.
    const owner = await getAccountExport(publicUser(userB), "export-of-B");
    expect(owner).not.toBeInstanceOf(Response);
    expect((owner as { export: { id: string } }).export.id).toBe("export-of-B");

    // A guesses B's export id: scoped out → 404 Response, not B's row.
    const attacker = await getAccountExport(publicUser(userA), "export-of-B");
    expect(attacker).toBeInstanceOf(Response);
    expect((attacker as Response).status).toBe(404);
  });

  it("saved findings: A's list and unsave never touch B's rows", async () => {
    const { listSavedFindings, deleteSavedFinding } = await import("./account-data");

    const now = new Date().toISOString();

    await db.batch([
      {
        args: ["sf-a", userA, "track-shared-00000000", "log-shared", now],
        sql: `insert into user_saved_findings (id, user_id, track_id, log_id, saved_at)
          values (?, ?, ?, ?, ?)`,
      },
      {
        args: ["sf-b", userB, "track-shared-00000000", "log-shared", now],
        sql: `insert into user_saved_findings (id, user_id, track_id, log_id, saved_at)
          values (?, ?, ?, ?, ?)`,
      },
    ]);

    // A's list returns only A's saved finding.
    const aList = await listSavedFindings(publicUser(userA));
    expect(aList.savedFindings.map((f) => f.trackId)).toEqual(["track-shared-00000000"]);

    // A unsaves the SAME track id: only A's row is deleted; B's survives.
    const result = await deleteSavedFinding(publicUser(userA), "track-shared-00000000");
    expect(result).toEqual({ ok: true });

    const remaining = await db.execute("select id, user_id from user_saved_findings");
    expect(remaining.rows.length).toBe(1);
    expect(remaining.rows[0]?.user_id).toBe(userB);
  });

  it("listUserSubmissions: A only sees A's submissions", async () => {
    const { listUserSubmissions } = await import("./account-data");

    await seedSubmission(db, {
      id: "sub-a",
      spotifyTrackId: "track-shared-00000000",
      userId: userA,
    });
    await seedSubmission(db, {
      id: "sub-b",
      spotifyTrackId: "track-shared-00000000",
      userId: userB,
    });

    const aSubs = await listUserSubmissions(publicUser(userA));
    expect(aSubs.submissions.map((s) => s.id)).toEqual(["sub-a"]);

    const bSubs = await listUserSubmissions(publicUser(userB));
    expect(bSubs.submissions.map((s) => s.id)).toEqual(["sub-b"]);
  });
});

describe("saved sets (real SQL, owner-scoped)", () => {
  const userA = "user-A";
  const userB = "user-B";
  // Two 22-char base62 Spotify ids — valid `?set=` tokens with no DB row needed
  // (the codec accepts them; the name-derivation title lookup simply finds nothing
  // and falls back), so a set round-trips without seeding a certified finding.
  const SET_A = "4iV5W9uYEdYUVa79Axb7Rh,1301WleyT98MSxVHPZCA6M";

  beforeEach(async () => {
    await seedUser(db, { email: "a@example.com", id: userA, username: "aaa" });
    await seedUser(db, { email: "b@example.com", id: userB, username: "bbb" });
  });

  it("saveSet round-trips the chain + taste through the shared codec, list returns it", async () => {
    const { listSavedSets, saveSet } = await import("./account-data");

    const result = await saveSet(publicUser(userA), {
      name: "My set",
      set: SET_A,
      taste: "netsky,nu-tone",
    });
    expect(result).not.toBeInstanceOf(Response);

    const list = await listSavedSets(publicUser(userA));
    expect(list.savedSets).toHaveLength(1);
    expect(list.savedSets[0]?.name).toBe("My set");
    expect(list.savedSets[0]?.setTokens).toBe(SET_A);
    expect(list.savedSets[0]?.taste).toBe("netsky,nu-tone");
  });

  it("saveSet rejects an empty chain (400 empty_set)", async () => {
    const { saveSet } = await import("./account-data");

    const result = await saveSet(publicUser(userA), { set: "" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("saveSet derives a non-empty name when none is given", async () => {
    const { saveSet } = await import("./account-data");

    const result = (await saveSet(publicUser(userA), { set: SET_A })) as {
      savedSet: { name: string };
    };
    expect(result.savedSet.name.length).toBeGreaterThan(0);
  });

  it("list/update/delete are owner-scoped — A never touches B's set", async () => {
    const { deleteSavedSet, listSavedSets, saveSet, updateSavedSet } =
      await import("./account-data");

    const aSaved = (await saveSet(publicUser(userA), { name: "A's set", set: SET_A })) as {
      savedSet: { id: string };
    };
    const bSaved = (await saveSet(publicUser(userB), { name: "B's set", set: SET_A })) as {
      savedSet: { id: string };
    };

    // A's list holds only A's set.
    const aList = await listSavedSets(publicUser(userA));
    expect(aList.savedSets.map((s) => s.id)).toEqual([aSaved.savedSet.id]);

    // A cannot update B's set (scoped → 404).
    const updateAttempt = await updateSavedSet(publicUser(userA), bSaved.savedSet.id, {
      name: "hijacked",
    });
    expect(updateAttempt).toBeInstanceOf(Response);
    expect((updateAttempt as Response).status).toBe(404);

    // A cannot delete B's set (scoped → 404).
    const deleteAttempt = await deleteSavedSet(publicUser(userA), bSaved.savedSet.id);
    expect(deleteAttempt).toBeInstanceOf(Response);
    expect((deleteAttempt as Response).status).toBe(404);

    // B's set survived both attacks, name intact.
    const bList = await listSavedSets(publicUser(userB));
    expect(bList.savedSets.map((s) => s.id)).toEqual([bSaved.savedSet.id]);
    expect(bList.savedSets[0]?.name).toBe("B's set");
  });

  it("updateSavedSet overwrites name + chain for the owner", async () => {
    const { listSavedSets, saveSet, updateSavedSet } = await import("./account-data");

    const saved = (await saveSet(publicUser(userA), { name: "old", set: SET_A })) as {
      savedSet: { id: string };
    };
    const nextSet = "1301WleyT98MSxVHPZCA6M";
    await updateSavedSet(publicUser(userA), saved.savedSet.id, { name: "new", set: nextSet });

    const list = await listSavedSets(publicUser(userA));
    expect(list.savedSets[0]?.name).toBe("new");
    expect(list.savedSets[0]?.setTokens).toBe(nextSet);
  });

  it("deleteSavedSet clears only the owner's row", async () => {
    const { deleteSavedSet, listSavedSets, saveSet } = await import("./account-data");

    const saved = (await saveSet(publicUser(userA), { set: SET_A })) as {
      savedSet: { id: string };
    };
    const result = await deleteSavedSet(publicUser(userA), saved.savedSet.id);
    expect(result).toEqual({ ok: true });

    const list = await listSavedSets(publicUser(userA));
    expect(list.savedSets).toHaveLength(0);
  });

  it("exportAccountData includes the user's saved sets", async () => {
    const { exportAccountData, saveSet } = await import("./account-data");

    await saveSet(publicUser(userA), { name: "Export me", set: SET_A });
    const result = await exportAccountData(publicUser(userA));
    expect(result.export.savedSets.map((s) => s.name)).toEqual(["Export me"]);
  });
});

describe("user preferences (real SQL, closed schema + owner-scoped)", () => {
  const userA = "user-A";
  const userB = "user-B";

  beforeEach(async () => {
    await seedUser(db, { email: "a@example.com", id: userA, username: "aaa" });
    await seedUser(db, { email: "b@example.com", id: userB, username: "bbb" });
  });

  it("getUserPreferences returns an empty object when nothing is stored", async () => {
    const { getUserPreferences } = await import("./account-data");

    const result = await getUserPreferences(publicUser(userA));
    expect(result).toEqual({ ok: true, preferences: {} });
  });

  it("updateUserPreferences upserts, and getUserPreferences reads it back", async () => {
    const { getUserPreferences, updateUserPreferences } = await import("./account-data");

    const updated = await updateUserPreferences(publicUser(userA), { keyNotation: "camelot" });
    expect(updated).toEqual({ ok: true, preferences: { keyNotation: "camelot" } });

    const read = await getUserPreferences(publicUser(userA));
    expect(read.preferences).toEqual({ keyNotation: "camelot" });

    // Upsert (not a second row): a further write updates the same row in place.
    await updateUserPreferences(publicUser(userA), { keyNotation: "scales" });
    expect(await rowCount(db, "user_preferences")).toBe(1);
    expect((await getUserPreferences(publicUser(userA))).preferences).toEqual({
      keyNotation: "scales",
    });
  });

  it("merges partially — an empty patch preserves the stored value", async () => {
    const { getUserPreferences, updateUserPreferences } = await import("./account-data");

    await updateUserPreferences(publicUser(userA), { keyNotation: "camelot" });
    const merged = (await updateUserPreferences(publicUser(userA), {})) as {
      preferences: { keyNotation?: string };
    };
    expect(merged.preferences.keyNotation).toBe("camelot");
    expect((await getUserPreferences(publicUser(userA))).preferences.keyNotation).toBe("camelot");
  });

  it("rejects an unknown key (400 invalid_request — the closed .strict() schema)", async () => {
    const { updateUserPreferences } = await import("./account-data");

    const result = await updateUserPreferences(publicUser(userA), {
      theme: "dark",
    } as unknown);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    // A rejected write persists nothing.
    expect(await rowCount(db, "user_preferences")).toBe(0);
  });

  it("rejects an out-of-range value (400)", async () => {
    const { updateUserPreferences } = await import("./account-data");

    const result = await updateUserPreferences(publicUser(userA), {
      keyNotation: "bogus",
    } as unknown);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("tolerates a corrupt stored blob (reads as empty, never throws)", async () => {
    const now = new Date().toISOString();

    await db.execute({
      args: [userA, "not json {{{", now],
      sql: `insert into user_preferences (user_id, preferences, updated_at) values (?, ?, ?)`,
    });

    const { getUserPreferences } = await import("./account-data");
    const result = await getUserPreferences(publicUser(userA));
    expect(result.preferences).toEqual({});
  });

  it("is owner-scoped — A's write never touches B's row", async () => {
    const { getUserPreferences, updateUserPreferences } = await import("./account-data");

    await updateUserPreferences(publicUser(userA), { keyNotation: "camelot" });
    await updateUserPreferences(publicUser(userB), { keyNotation: "scales" });

    expect((await getUserPreferences(publicUser(userA))).preferences).toEqual({
      keyNotation: "camelot",
    });
    expect((await getUserPreferences(publicUser(userB))).preferences).toEqual({
      keyNotation: "scales",
    });
  });

  it("exportAccountData includes the user's preferences", async () => {
    const { exportAccountData, updateUserPreferences } = await import("./account-data");

    await updateUserPreferences(publicUser(userA), { keyNotation: "camelot" });
    const result = await exportAccountData(publicUser(userA));
    expect(result.export.preferences).toEqual({ keyNotation: "camelot" });
  });
});

describe("listGalaxyCollection (real SQL, the collection browser read)", () => {
  const userA = publicUser("collector-a");
  const userB = publicUser("collector-b");

  async function seedGalaxy(
    id: string,
    name: null | string,
    slug: null | string,
    retiredAt: null | string = null,
  ): Promise<void> {
    const now = new Date().toISOString();

    await db.execute({
      args: [id, `${id}-handle`, name, slug, retiredAt, "[]", now, now],
      sql: `insert into galaxies (id, handle, name, slug, retired_at, centroid_json, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`,
    });
  }

  async function assignGalaxy(trackId: string, galaxyId: string): Promise<void> {
    await db.execute({
      args: [galaxyId, trackId],
      sql: `update findings set galaxy_id = ? where track_id = ?`,
    });
  }

  // The fully-named map: two live named galaxies + one RETIRED named galaxy (which
  // must leak nowhere) + one finding with no galaxy assignment at all. The unnamed
  // half-named-map case gets its own test below (it flips the whole gate).
  beforeEach(async () => {
    const { collectLogId } = await import("./account-data");

    await seedUser(db, { email: "a@x.test", id: userA.id, username: userA.id });
    await seedUser(db, { email: "b@x.test", id: userB.id, username: userB.id });
    await seedGalaxy("g-lunar", "Lunar", "lunar");
    await seedGalaxy("g-solar", "Solar", "solar");
    await seedGalaxy("g-dead", "Dead", "dead", new Date().toISOString());
    await seedTrack(db, { logId: "log-l1", title: "Roller One", trackId: "track-lunar-1-000000" });
    await seedTrack(db, { logId: "log-l2", title: "Roller Two", trackId: "track-lunar-2-000000" });
    await seedTrack(db, { logId: "log-s1", title: "Lift Off", trackId: "track-solar-1-000000" });
    await seedTrack(db, { logId: "log-d1", title: "Ghost", trackId: "track-dead-1-0000000" });
    await seedTrack(db, { logId: "log-u1", title: "Drift", trackId: "track-unassigned-0000" });
    await assignGalaxy("track-lunar-1-000000", "g-lunar");
    await assignGalaxy("track-lunar-2-000000", "g-lunar");
    await assignGalaxy("track-solar-1-000000", "g-solar");
    await assignGalaxy("track-dead-1-0000000", "g-dead");
    await collectLogId(userA, "log-l1");
    await collectLogId(userA, "log-d1");
    await collectLogId(userA, "log-u1");
    await collectLogId(userB, "log-l2");
  });

  it("returns the user's rows enriched with the finding + galaxy, oldest first", async () => {
    const { listGalaxyCollection } = await import("./account-data");
    const result = await listGalaxyCollection(userA);

    expect(result.ok).toBe(true);
    expect(result.collection.map((item) => item.logId)).toEqual(["log-l1", "log-d1", "log-u1"]);

    const lunarItem = result.collection[0];

    expect(lunarItem?.title).toBe("Roller One");
    expect(lunarItem?.artists).toEqual(["Test Artist"]);
    expect(lunarItem?.galaxyName).toBe("Lunar");
    expect(lunarItem?.galaxySlug).toBe("lunar");
    expect(lunarItem?.firstCollectedAt).toBeTruthy();
  });

  it("an unassigned finding reaches the client with NO galaxy name (unheaded)", async () => {
    const { listGalaxyCollection } = await import("./account-data");
    const result = await listGalaxyCollection(userA);
    const unassignedItem = result.collection.find((item) => item.logId === "log-u1");

    expect(unassignedItem).toBeDefined();
    expect(unassignedItem?.galaxyName).toBeUndefined();
    expect(unassignedItem?.galaxySlug).toBeUndefined();
  });

  it("a retired galaxy leaks nowhere: no completion line, and its finding loses the clause", async () => {
    const { listGalaxyCollection } = await import("./account-data");
    const result = await listGalaxyCollection(userA);

    expect(result.galaxies.find((galaxy) => galaxy.slug === "dead")).toBeUndefined();

    const deadItem = result.collection.find((item) => item.logId === "log-d1");

    expect(deadItem?.galaxyName).toBeUndefined();
    expect(deadItem?.galaxySlug).toBeUndefined();
  });

  it("completion lines cover live NAMED galaxies only, with per-user collected counts", async () => {
    const { listGalaxyCollection } = await import("./account-data");
    const result = await listGalaxyCollection(userA);

    expect(result.galaxies).toEqual([
      { collected: 1, name: "Lunar", slug: "lunar", total: 2 },
      { collected: 0, name: "Solar", slug: "solar", total: 1 },
    ]);
  });

  it("is owner-scoped — B's collects never appear in A's collection", async () => {
    const { listGalaxyCollection } = await import("./account-data");
    const [resultA, resultB] = [
      await listGalaxyCollection(userA),
      await listGalaxyCollection(userB),
    ];

    expect(resultA.collection.map((item) => item.logId)).toEqual(["log-l1", "log-d1", "log-u1"]);
    expect(resultB.collection.map((item) => item.logId)).toEqual(["log-l2"]);
    expect(resultB.galaxies.find((galaxy) => galaxy.slug === "lunar")?.collected).toBe(1);
  });

  it("GATES the whole galaxy layer while the map is half-named (isGalaxyMapFullyNamed)", async () => {
    const { listGalaxyCollection } = await import("./account-data");

    // One live UNNAMED galaxy flips the gate: names and completion lines vanish,
    // the collection itself stays (flat, unheaded).
    await seedGalaxy("g-fresh", null, null);

    const result = await listGalaxyCollection(userA);

    expect(result.galaxies).toEqual([]);
    expect(result.collection.map((item) => item.logId)).toEqual(["log-l1", "log-d1", "log-u1"]);
    expect(result.collection.every((item) => item.galaxyName === undefined)).toBe(true);
    expect(result.collection.every((item) => item.galaxySlug === undefined)).toBe(true);
  });
});
