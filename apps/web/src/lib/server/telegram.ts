import { logPageUrl } from "../fluncle-links";
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
