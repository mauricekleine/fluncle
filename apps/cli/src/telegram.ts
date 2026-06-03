import { loadEnv } from "./env";
import { type TrackMetadata } from "./spotify";

export function formatTelegramMessage(track: TrackMetadata, note?: string): string {
  const artistLine = `${track.artists.join(", ")} — ${track.title}`;
  const lines = [`📻 Fluncle's Finest`, "", artistLine];

  if (note?.trim()) {
    lines.push(note.trim());
  }

  lines.push("", `🎧 Spotify: ${track.spotifyUrl}`);

  return lines.join("\n");
}

export async function postToTelegram(track: TrackMetadata, note?: string): Promise<void> {
  const env = loadEnv(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        text: formatTelegramMessage(track, note),
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
