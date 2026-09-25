import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRow } from "./db";
import { type FollowTarget } from "./follow-intent";

export type ResolvedFollowTarget = FollowTarget & { name: string; slug: string };

type TargetRow = { id: string; name: string | null; slug: string | null };

export async function resolveFollowTarget(
  target: FollowTarget,
): Promise<ResolvedFollowTarget | undefined> {
  const sql =
    target.kind === "artist"
      ? `select a.id, a.name, a.slug from artists a where a.id = ? and ${listedArtistWhere("a")} limit 1`
      : `select l.id, l.name, l.slug from labels l where l.id = ? limit 1`;
  const result = await (await getDb()).execute({ args: [target.entityId], sql });
  const row = typedRow<TargetRow>(result.rows);

  if (!row?.name || !row.slug) {
    return undefined;
  }

  return { entityId: row.id, kind: target.kind, name: row.name, slug: row.slug };
}
