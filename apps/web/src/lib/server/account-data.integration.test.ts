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
  return { createdAt: new Date().toISOString(), id, username: id };
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
