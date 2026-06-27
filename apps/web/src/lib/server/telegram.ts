import { logPageUrl, twitchUrl } from "../fluncle-links";
import { readEnvs } from "./env";
import { type TrackMetadata } from "./spotify";

const notePrefix = "Why I'm playing it:";

export function formatTelegramMessage(track: TrackMetadata, note?: string, logId?: string): string {
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const lines = [`🛸 Fluncle's Findings`, "", artistLine];

  if (note?.trim()) {
    lines.push(`${notePrefix} ${note.trim()}`);
  }

  lines.push("", `🎧 Spotify: ${track.spotifyUrl}`);

  // The finding's permanent home: its own log page, quiet under the Spotify
  // link. Only when the coordinate exists (older posts predate the Log ID).
  if (logId?.trim()) {
    lines.push(`Read the log: ${logPageUrl(logId)}`);
  }

  return lines.join("\n");
}

export async function postToTelegram(
  track: TrackMetadata,
  note?: string,
  logId?: string,
): Promise<void> {
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        text: formatTelegramMessage(track, note, logId),
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram post failed: ${response.status} ${response.statusText} - ${body}`);
  }
}

// The crew callout for the live-set: Fluncle on the decks, first-person, turned to
// the crew (the Selector's Rule), the literal Twitch link under it. `live` as the
// Twitch state is fine; "transmission"/"signal"/"stream" as identity are not.
export function formatLiveTelegramMessage(title?: string | null): string {
  const lines = ["🛸 On the decks, live", "", "I'm mixing live right now, cosmonauts. Pull up."];

  if (title?.trim()) {
    lines.push(`“${title.trim()}”`);
  }

  lines.push("", `🎧 ${twitchUrl}`);

  return lines.join("\n");
}

// Post the live-set callout to the crew channel and return the new message's id
// (so the on→off transition can unpin it). Returns null when the send fails or the
// response omits the id — the caller treats Telegram as best-effort.
export async function postLiveToTelegram(title?: string | null): Promise<number | null> {
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        text: formatLiveTelegramMessage(title),
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram live post failed: ${response.status} ${response.statusText} - ${body}`,
    );
  }

  const payload = (await response.json()) as { ok: boolean; result?: { message_id?: number } };
  return payload.result?.message_id ?? null;
}

// Pin a message in the crew channel (the live callout, for the duration of the set).
// Silent pin — no extra notification on top of the post. Best-effort; the caller
// swallows a failure so a missing pin right never blocks the send.
export async function pinChatMessage(messageId: number): Promise<void> {
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/pinChatMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        disable_notification: true,
        message_id: messageId,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram pin failed: ${response.status} ${response.statusText} - ${body}`);
  }
}

// Unpin the live callout when the set ends.
export async function unpinChatMessage(messageId: number): Promise<void> {
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/unpinChatMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        message_id: messageId,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram unpin failed: ${response.status} ${response.statusText} - ${body}`);
  }
}
