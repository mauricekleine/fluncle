// The lean global-flag KV (the `settings` table) — the ONE store every operator kill
// switch rides. A kill switch has to be a flip, not a deploy: an automation that
// misbehaves at 3am must be stoppable from the admin UI or the CLI in one move, with no
// build, no push, no Cloudflare rebuild. So each switch is a single row here, read by the
// automation's own tick before it does anything.
//
// Three switches live on it today, all the same shape (a `"true"`/`"false"` string under a
// stable key, unset ⇒ OFF):
//   - `clip_drip_paused`         — the Instagram clip drip-feed (./clip-social.ts)
//   - `publish_advance_paused`   — the render → publish auto-advance (./publish-advance.ts)
//   - `catalogue_capture_paused` — the metered catalogue audio capture (./capture-budget.ts)
//
// And the KV also carries the first BUDGET (a non-negative integer as a string), because a
// spending limit has exactly the same requirement a kill switch does — changeable in one
// flip, with no deploy — and so it wants the same store:
//   - `catalogue_capture_daily_tracks` / `catalogue_capture_daily_bytes` — the capture
//     budget's rolling-24h caps (./capture-budget.ts). Unset or malformed ⇒ the conservative
//     DEFAULT, never "unlimited": the failure mode of a budget must be a smaller budget.
//
// Reuse these for the next one; never invent a second flag store.

import { getDb, typedRow } from "./db";

/** Read a global flag from the `settings` KV, or undefined if unset. */
export async function getSetting(key: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [key],
    sql: `select value from settings where key = ? limit 1`,
  });

  return typedRow<{ value: string }>(result.rows)?.value;
}

/** Upsert a global flag into the `settings` KV. */
export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [key, value, value],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = ?`,
  });
}
