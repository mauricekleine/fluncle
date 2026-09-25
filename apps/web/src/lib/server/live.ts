import { twitchUrl } from "../fluncle-links";
import { getDb, typedRow } from "./db";
import { logEvent } from "./log";
import { pinChatMessage, postLiveToTelegram, unpinChatMessage } from "./telegram";

const LIVE_ROW_ID = "twitch";

const STALENESS_MS = 5 * 60 * 1000;

type LiveStateRow = {
  id: string;
  live: number;
  title: string | null;
  started_at: string | null;
  tg_message_id: number | null;
  updated_at: string;
};

export type LiveState = {
  on: boolean;
  title: string | null;
  startedAt: string | null;
  url: string;
};

export type SetLiveInput = {
  live: boolean;
  title: string | null;
  startedAt: string | null;

  at: string;
};

const OFFLINE: LiveState = { on: false, startedAt: null, title: null, url: twitchUrl };

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
    logEvent("error", "live.state-read-failed", { error });
    return OFFLINE;
  }
}

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

  if (!wasLive && input.live) {
    try {
      const messageId = await postLiveToTelegram(input.title);

      if (messageId !== null) {
        tgMessageId = messageId;

        try {
          await pinChatMessage(messageId);
        } catch (pinError) {
          logEvent("error", "live.callout-pin-failed", { error: pinError });
        }
      }
    } catch (error) {
      logEvent("error", "live.callout-post-failed", { error });
    }
  } else if (wasLive && !input.live) {
    if (tgMessageId !== null) {
      try {
        await unpinChatMessage(tgMessageId);
      } catch (error) {
        logEvent("error", "live.callout-unpin-failed", { error });
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
