// The live-set callout store — the server side of "Fluncle is on the decks right
// now", the one loud, ephemeral beat that fans out across every surface while the
// Twitch stream is on and clears the moment it ends. Mirrors `status.ts`: `getDb()`
// + raw SQL + `typedRow`, one single-row table (`live_state`). Two halves:
//
//   - READ (every surface): `getLiveState` — the single read source for the web
//     home loader, `/api/status`, the MCP live-note, and (via /api/status) SSH,
//     CLI, and dig. Applies the STALENESS GUARD: a flag older than the window is
//     treated as offline, so a dead poller mid-set can never strand a permanent
//     "LIVE" banner. Auto-clear is self-healing regardless of poller health.
//   - WRITE (the on-box poller): `setLiveState` — upsert the single row from the
//     `record_live_state` op, detect the off→on / on→off TRANSITION against the stored row,
//     and fire the crew Telegram callout on go-live (send + pin, capturing the
//     message id) / unpin on end. Side-effects are best-effort: a Telegram failure
//     never fails the write, and the staleness guard remains the read-side backstop.
//
// PUBLIC-SAFE by construction: only the live boolean, the public stream title, the
// Twitch `started_at`, and our own timestamps ever flow through `getLiveState`.

import { twitchUrl } from "../fluncle-links";
import { getDb, typedRow } from "./db";
import { pinChatMessage, postLiveToTelegram, unpinChatMessage } from "./telegram";

// The single `live_state` row's PK — one channel, one row.
const LIVE_ROW_ID = "twitch";

// A flag older than this is treated as offline (the read-side auto-clear). The
// poller refreshes ~every minute, so five minutes tolerates a few missed ticks
// before a surface clears itself.
const STALENESS_MS = 5 * 60 * 1000;

/** The `live_state` row as stored (raw SQL shape; `live` is SQLite 0/1). */
type LiveStateRow = {
  id: string;
  live: number;
  title: string | null;
  started_at: string | null;
  tg_message_id: number | null;
  updated_at: string;
};

/** The public live state every surface reads — staleness already applied. */
export type LiveState = {
  on: boolean;
  title: string | null;
  startedAt: string | null;
  url: string;
};

/** The raw Twitch state the poller POSTs via `record_live_state`. */
export type SetLiveInput = {
  live: boolean;
  title: string | null;
  startedAt: string | null;
  // ISO instant of this poll — the staleness anchor (`updated_at`).
  at: string;
};

const OFFLINE: LiveState = { on: false, startedAt: null, title: null, url: twitchUrl };

/**
 * The current live state, with the staleness guard applied — the single read source
 * for every surface. Returns offline when the flag is off, missing, or stale (older
 * than `STALENESS_MS`). Resilient by design: any read error (e.g. the table not yet
 * migrated during a deploy window) returns offline rather than throwing, so the
 * home loader / `/api/status` / MCP never break on a live read.
 */
export async function getLiveState(): Promise<LiveState> {
  try {
    const db = await getDb();
    const result = await db.execute({
      args: [LIVE_ROW_ID],
      sql: `select id, live, title, started_at, tg_message_id, updated_at
              from live_state
              where id = ?`,
    });

    const row = typedRow<LiveStateRow>(result.rows);

    if (!row || row.live !== 1) {
      return OFFLINE;
    }

    const updatedMs = Date.parse(row.updated_at);

    if (Number.isNaN(updatedMs) || Date.now() - updatedMs > STALENESS_MS) {
      return OFFLINE;
    }

    return { on: true, startedAt: row.started_at, title: row.title, url: twitchUrl };
  } catch (error) {
    console.error("getLiveState: read failed (treating as offline)", error);
    return OFFLINE;
  }
}

/**
 * Persist one poll of the Twitch live state and run the transition side-effects.
 * Reads the stored row to detect the transition against the RAW stored `live` (not
 * the staleness-adjusted read), then upserts the single row:
 *   - off→on: post the crew callout and pin it, storing the message id for unpin.
 *   - on→off: unpin the stored callout (if any) and clear the id.
 *   - no change: carry the stored message id forward.
 * Telegram is best-effort — a failure is logged, never thrown, and never blocks the
 * write (the read-side staleness guard is the backstop).
 */
export async function setLiveState(input: SetLiveInput): Promise<void> {
  const db = await getDb();

  const existing = typedRow<LiveStateRow>(
    (
      await db.execute({
        args: [LIVE_ROW_ID],
        sql: `select id, live, title, started_at, tg_message_id, updated_at
                from live_state
                where id = ?`,
      })
    ).rows,
  );

  const wasLive = existing?.live === 1;
  let tgMessageId = existing?.tg_message_id ?? null;

  // Off→on: announce + pin the crew callout. On→off: unpin it. Both best-effort.
  if (!wasLive && input.live) {
    try {
      const messageId = await postLiveToTelegram(input.title);

      if (messageId !== null) {
        tgMessageId = messageId;

        try {
          await pinChatMessage(messageId);
        } catch (pinError) {
          // A missing pin right degrades to a plain ping — never blocks go-live.
          console.error("setLiveState: pin failed (callout sent unpinned)", pinError);
        }
      }
    } catch (error) {
      console.error("setLiveState: live callout post failed (best-effort)", error);
    }
  } else if (wasLive && !input.live) {
    if (tgMessageId !== null) {
      try {
        await unpinChatMessage(tgMessageId);
      } catch (error) {
        console.error("setLiveState: unpin failed (best-effort)", error);
      }
    }

    tgMessageId = null;
  }

  await db.execute({
    args: [LIVE_ROW_ID, input.live ? 1 : 0, input.title, input.startedAt, tgMessageId, input.at],
    sql: `insert into live_state (id, live, title, started_at, tg_message_id, updated_at)
            values (?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              live = excluded.live,
              title = excluded.title,
              started_at = excluded.started_at,
              tg_message_id = excluded.tg_message_id,
              updated_at = excluded.updated_at`,
  });
}
