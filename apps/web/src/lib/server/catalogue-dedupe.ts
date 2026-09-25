import { type Client } from "@libsql/client";

import { getDb, typedRows } from "./db";

export function foldTrackTitle(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export async function existingAlbumTitleFolds(
  albumId: null | string,
  client?: Pick<Client, "execute">,
): Promise<Map<string, string>> {
  if (!albumId) {
    return new Map();
  }

  const db = client ?? (await getDb());
  const result = await db.execute({
    args: [albumId],
    sql: `select track_id, title from tracks where album_id = ?`,
  });

  const byFold = new Map<string, string>();

  for (const row of typedRows<{ title: null | string; track_id: string }>(result.rows)) {
    const title = typeof row.title === "string" ? row.title.trim() : "";

    if (!title) {
      continue;
    }

    const fold = foldTrackTitle(title);

    if (fold && !byFold.has(fold)) {
      byFold.set(fold, row.track_id);
    }
  }

  return byFold;
}
