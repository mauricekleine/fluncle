import { type UserAdminItem } from "@fluncle/contracts";
import { getDb, typedRows } from "./db";

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

const USER_ROSTER_LIMIT = 500;

function msToIso(ms: number): string {
  return new Date(Number(ms)).toISOString();
}

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
