import { Data, Duration, Effect } from "effect";
import { logPageUrl, twitchUrl } from "../fluncle-links";
import { type MixtapeDTO, mixtapeDisplayTitle } from "../mixtapes";
import { readEnvs } from "./env";
import { runServerEffect } from "./effect/runtime";
import { type TrackMetadata } from "./spotify";

class TelegramRequestFailed extends Data.TaggedError("TelegramRequestFailed")<{
  cause: unknown;
}> {}

async function telegramRequest<T>(
  method: string,
  body: Record<string, unknown>,
  label: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  return runServerEffect(
    Effect.tryPromise({
      catch: (cause) => new TelegramRequestFailed({ cause }),
      try: async (signal) => {
        const response = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
          {
            body: JSON.stringify({ chat_id: env.TELEGRAM_CHANNEL_ID, ...body }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal,
          },
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${label}: ${response.status} ${response.statusText} - ${text}`);
        }
        return read(response);
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(15),
        orElse: () =>
          Effect.fail(
            new TelegramRequestFailed({ cause: new Error(`${label}: request timed out`) }),
          ),
      }),
      Effect.catchTag("TelegramRequestFailed", (error) => Effect.fail(error.cause)),
    ),
  );
}

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
  return telegramRequest(
    "sendMessage",
    { text: formatTelegramMessage(track, note, logId) },
    "Telegram post failed",
    async () => undefined,
  );
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
  await telegramRequest(
    "sendMessage",
    { disable_web_page_preview: true, text },
    "Telegram mixtape post failed",
    async () => undefined,
  );
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
  return telegramRequest(
    "sendMessage",
    { text: formatLiveTelegramMessage(title) },
    "Telegram live post failed",
    async (response) => {
      const payload = (await response.json()) as { ok: boolean; result?: { message_id?: number } };
      return payload.result?.message_id ?? null;
    },
  );
}

export async function pinChatMessage(messageId: number): Promise<void> {
  return telegramRequest(
    "pinChatMessage",
    { disable_notification: true, message_id: messageId },
    "Telegram pin failed",
    async () => undefined,
  );
}

export async function unpinChatMessage(messageId: number): Promise<void> {
  return telegramRequest(
    "unpinChatMessage",
    { message_id: messageId },
    "Telegram unpin failed",
    async () => undefined,
  );
}
