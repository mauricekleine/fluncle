// The user-account roster's backing read — the `labels.ts` / `artists.ts` twin,
// consumed by the oRPC handler (`./orpc/admin-users.ts`) and the `/admin/users`
// route loader. READ-ONLY: this module only lists accounts and their derived
// artifact counts; it never mutates the account lifecycle (that lives behind Better
// Auth and the user's own `/me` tier).
//
// ── ONE BOUNDED QUERY, COUNTED IN SQL ──────────────────────────────────────────
// The three per-user artifact counts are correlated subqueries evaluated IN SQLite,
// never by pulling the artifact tables into the isolate to count them (the repo DB
// law). Each subquery hits an index on its `user_id` prefix
// (`user_saved_findings_user_track_idx`, `user_saved_sets_user_updated_idx`, and the
// `user_galaxy_state` primary key), so the read stays cheap as the roster grows. The
// `"user"` table is quoted because `user` is a reserved word in SQLite.

import { type UserAdminItem } from "@fluncle/contracts";
import { getDb, typedRows } from "./db";

/** A row from the roster read (snake_case columns + the derived counts). */
type UserRosterRow = {
  created_at: number;
  display_username: string | null;
  email: string;
  email_verified: number;
  has_galaxy: number;
  id: string;
  image: string | null;
  last_seen_at: number | null;
  name: string;
  saved_finding_count: number;
  saved_set_count: number;
  status: "active" | "suspended" | "deleted";
  username: string | null;
};

// A generous cap so the newest-first roster stays a single bounded read. The account
// base is small today; this keeps it bounded by construction as it grows, and the
// station's job (watch the rollout) never needs the whole tail at once.
const USER_ROSTER_LIMIT = 500;

/** `created_at`/`last_seen_at` are stored as integer epoch-ms; the wire wants ISO. */
function msToIso(ms: number): string {
  return new Date(Number(ms)).toISOString();
}

/**
 * Every account, newest-first, each with its verified/status flags and its three
 * derived artifact counts (saved findings, saved `/mix` sets, whether a
 * `user_galaxy_state` row exists at all). One bounded query; the counts are computed
 * in SQL. Capped at {@link USER_ROSTER_LIMIT}.
 */
export async function listAdminUsers(): Promise<UserAdminItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [USER_ROSTER_LIMIT],
    sql: `select
            u.id as id,
            u.email as email,
            u.name as name,
            u.username as username,
            u.display_username as display_username,
            u.email_verified as email_verified,
            u.image as image,
            u.status as status,
            u.created_at as created_at,
            u.last_seen_at as last_seen_at,
            (select count(*) from user_saved_findings s where s.user_id = u.id) as saved_finding_count,
            (select count(*) from user_saved_sets ss where ss.user_id = u.id) as saved_set_count,
            (select exists (select 1 from user_galaxy_state g where g.user_id = u.id)) as has_galaxy
          from "user" u
          order by u.created_at desc
          limit ?`,
  });

  return typedRows<UserRosterRow>(result.rows).map((row) => ({
    createdAt: msToIso(row.created_at),
    displayUsername: row.display_username,
    email: row.email,
    emailVerified: Boolean(row.email_verified),
    hasGalaxyProgress: Boolean(row.has_galaxy),
    id: row.id,
    image: row.image,
    lastSeenAt: row.last_seen_at == null ? null : msToIso(row.last_seen_at),
    name: row.name,
    savedFindingCount: Number(row.saved_finding_count),
    savedSetCount: Number(row.saved_set_count),
    status: row.status,
    username: row.username,
  }));
}
