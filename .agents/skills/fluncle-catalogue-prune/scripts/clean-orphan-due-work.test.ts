import { test, expect } from "bun:test";

import { createProjectionTestDb } from "../../../../apps/web/src/test/projection-schema";

import { cleanOrphanDueWork } from "./clean-orphan-due-work";

test("dry run and apply retire orphan due work across states and page boundaries", async () => {
  const db = await createProjectionTestDb();
  try {
    await db.execute("insert into tracks (track_id) values ('live')");
    for (let index = 0; index < 201; index += 1) {
      await db.execute({
        args: [`gone-${String(index).padStart(3, "0")}`, index % 2 === 0 ? "ready" : "scheduled"],
        sql: `insert into due_work (work_kind, subject_type, subject_id, state)
          values ('capture-catalogue', 'track', ?, ?)`,
      });
    }
    await db.execute(`insert into due_work (work_kind, subject_type, subject_id, state)
      values ('anchor-catalogue', 'track', 'gone-anchor', 'repair'),
        ('capture-catalogue', 'track', 'live', 'ready'),
        ('artist-bio', 'artist', 'gone-artist', 'ready')`);

    expect(await cleanOrphanDueWork(db, false)).toEqual({ deleted: 0, found: 202, scanned: 203 });
    expect(await cleanOrphanDueWork(db, true)).toEqual({ deleted: 202, found: 202, scanned: 203 });
    expect(
      (
        await db.execute(
          "select work_kind, subject_type, subject_id from due_work order by work_kind",
        )
      ).rows.map((row) => [row.work_kind, row.subject_type, row.subject_id]),
    ).toEqual([
      ["artist-bio", "artist", "gone-artist"],
      ["capture-catalogue", "track", "live"],
    ]);
  } finally {
    db.close();
  }
});
