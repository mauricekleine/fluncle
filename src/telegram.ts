import { loadEnv } from "./env";
import type { TrackMetadata } from "./spotify";

export function formatTelegramMessage(track: TrackMetadata, note?: string): string {
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const noteLine = note?.trim() ? `${note.trim()}\n\n` : "";

  return `📻 Fluncle's Finest

${artistLine}
${noteLine}
🎧 Spotify: ${track.spotifyUrl}`;
}

export async function postToTelegram(track: TrackMetadata, note?: string): Promise<void> {
  const env = loadEnv(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHANNEL_ID,
      text: formatTelegramMessage(track, note),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram post failed: ${response.status} ${response.statusText} - ${body}`);
  }
}
