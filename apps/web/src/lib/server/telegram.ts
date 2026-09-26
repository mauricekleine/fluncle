import { logPageUrl, twitchUrl } from "../fluncle-links";
import { type MixtapeDTO, mixtapeDisplayTitle } from "../mixtapes";
import { readEnvs } from "./env";
import { type TrackMetadata } from "./spotify";

const notePrefix = "Why I'm playing it:";

export function formatTelegramMessage(track: TrackMetadata, note?: string, logId?: string): string {
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const lines = [`🛸 Fluncle's Findings`, "", artistLine];

  if (note?.trim()) {
    lines.push(`${notePrefix} ${note.trim()}`);
  }

  if (track.spotifyUrl) {
    lines.push("", `🎧 Spotify: ${track.spotifyUrl}`);
  }

  if (logId?.trim()) {
    if (!track.spotifyUrl) {
      lines.push("");
    }

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

const DEFAULT_DREAM_LINE =
  "I mixed a whole run of findings down into one long mixtape. A checkpoint before the next sector, the nearest you'll get to hearing me dream.";

const CREW_TURN = "Pull it up loud, cosmonauts.";

export function formatMixtapeAnnouncement(mixtape: {
  externalUrls: { mixcloud?: string; soundcloud?: string; youtube?: string };
  logId?: string;
  note?: string | null;
  title: string;
}): string {
  const note = mixtape.note?.trim();
  const lines = [
    "🛸 Fresh mixtape",
    "",
    note && note.length > 0 ? note : DEFAULT_DREAM_LINE,
    CREW_TURN,
  ];

  const titleLine = mixtapeDisplayTitle(mixtape.title);
  lines.push("", mixtape.logId ? `${titleLine} · fluncle://${mixtape.logId}` : titleLine);

  const listen: string[] = [];

  if (mixtape.externalUrls.youtube) {
    listen.push(`🎧 YouTube: ${mixtape.externalUrls.youtube}`);
  }

  if (mixtape.externalUrls.mixcloud) {
    listen.push(`🎧 Mixcloud: ${mixtape.externalUrls.mixcloud}`);
  }

  if (mixtape.externalUrls.soundcloud) {
    listen.push(`🎧 SoundCloud: ${mixtape.externalUrls.soundcloud}`);
  }

  if (listen.length > 0) {
    lines.push("", ...listen);
  }

  if (mixtape.logId) {
    lines.push(`Read the log: ${logPageUrl(mixtape.logId)}`);
  }

  return lines.join("\n");
}

export async function postMixtapeToTelegram(mixtape: MixtapeDTO): Promise<string> {
  const text = formatMixtapeAnnouncement(mixtape);
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,

        disable_web_page_preview: true,
        text,
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
      `Telegram mixtape post failed: ${response.status} ${response.statusText} - ${body}`,
    );
  }

  return text;
}

export function formatLiveTelegramMessage(title?: string | null): string {
  const lines = ["🛸 On the decks, live", "", "I'm mixing live right now, cosmonauts. Pull up."];

  if (title?.trim()) {
    lines.push(`“${title.trim()}”`);
  }

  lines.push("", `🎧 ${twitchUrl}`);

  return lines.join("\n");
}

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
