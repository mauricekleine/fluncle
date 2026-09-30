#!/usr/bin/env bun

import { type Client } from "@libsql/client/web";

import { getDb, rowString } from "./lib";

const PAGE_SIZE = 200;

export async function cleanOrphanDueWork(
  db: Client,
  apply: boolean,
): Promise<{
  deleted: number;
  found: number;
  scanned: number;
}> {
  let cursor: { subjectId: string; subjectType: string; workKind: string } | undefined;
  let deleted = 0;
  let found = 0;
  let scanned = 0;

  while (true) {
    const result = await db.execute({
      args: cursor
        ? [cursor.workKind, cursor.subjectType, cursor.subjectId, PAGE_SIZE]
        : [PAGE_SIZE],
      sql: `select work_kind, subject_type, subject_id,
          (due_work.subject_id like '@%' or exists (select 1 from tracks t where t.track_id = due_work.subject_id)) as track_exists
        from due_work
        where ${cursor ? "(work_kind, subject_type, subject_id) > (?, ?, ?) and " : ""}subject_type = 'track'
        order by work_kind, subject_type, subject_id
        limit ?`,
    });
    const rows = result.rows.map((row) => ({
      exists: Number(row.track_exists) === 1,
      subjectId: rowString(row, "subject_id"),
      subjectType: rowString(row, "subject_type"),
      workKind: rowString(row, "work_kind"),
    }));
    scanned += rows.length;
    const orphanByKind = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.exists) {
        const ids = orphanByKind.get(row.workKind) ?? [];
        ids.push(row.subjectId);
        orphanByKind.set(row.workKind, ids);
        found += 1;
      }
    }
    if (apply && orphanByKind.size > 0) {
      const statements = [...orphanByKind].map(([workKind, ids]) => ({
        args: [workKind, ...ids],
        sql: `delete from due_work where work_kind = ? and subject_type = 'track'
          and subject_id in (${ids.map(() => "?").join(", ")})
          and subject_id not like '@%'
          and not exists (select 1 from tracks t where t.track_id = due_work.subject_id)`,
      }));
      const results = await db.batch(statements, "write");
      deleted += results.reduce((sum, entry) => sum + entry.rowsAffected, 0);
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE_SIZE) {
      return { deleted, found, scanned };
    }
    cursor = last;
  }
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  try {
    const result = await cleanOrphanDueWork(db, apply);
    console.log(JSON.stringify({ ...result, mode: apply ? "apply" : "dry-run" }));
  } finally {
    db.close();
  }
}
