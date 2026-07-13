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

  // A certified catalogue row can have NO Spotify presence (no stored identity, no exact-ISRC
  // match — publish.ts's certify fan-out); the crew post omits the line rather than printing a
  // broken one. Every Spotify-add finding carries a URL, so nothing changes on that path.
  if (track.spotifyUrl) {
    lines.push("", `🎧 Spotify: ${track.spotifyUrl}`);
  }

  // The finding's permanent home: its own log page, quiet under the Spotify
  // link. Only when the coordinate exists (older posts predate the Log ID).
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

// The default dream/checkpoint framing when the operator hasn't authored a dream
// note — Fluncle in first person (active voice, he does the verb), the mixtape as him
// dreaming a run of findings into one long-term memory, a checkpoint before the next
// sector (the spine model). The Sauce rides the real DJ act of mixing them down.
const DEFAULT_DREAM_LINE =
  "I mixed a whole run of findings down into one long one. A checkpoint before the next sector, the nearest you'll get to hearing me dream.";
// The pass + address (the Selector's Rule): hand it to the crew, name them as kin.
// Dry Rule: no exclamation mark.
const CREW_TURN = "Pull it up loud, cosmonauts.";

// The crew callout for a published mixtape: Fluncle sharing his own dream/checkpoint.
// Mirrors formatTelegramMessage's shape (🛸 header → body → 🎧 listen links → the /log
// line) but in the mixtape's OWN voice, not a finding's. The operator's dream note (if
// authored) leads; else the default dream line. Always turns to the crew at the end
// (the Selector's Rule). The listen links are whichever platforms landed; the /log page
// is its permanent home. Pure + exported so it can be unit-tested without the transport.
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

  // The display title (the " | <coordinate>" suffix stripped — the coordinate rides
  // on its own line right after) + the F-marked Log ID as the mixtape's coordinate.
  const titleLine = mixtapeDisplayTitle(mixtape.title);
  lines.push("", mixtape.logId ? `${titleLine} · fluncle://${mixtape.logId}` : titleLine);

  // The listen links — YouTube + Mixcloud + SoundCloud, whichever the mixtape carries.
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

  // Its permanent home: the `/log/<F-id>` page, quiet under the listen links.
  if (mixtape.logId) {
    lines.push(`Read the log: ${logPageUrl(mixtape.logId)}`);
  }

  return lines.join("\n");
}

// Post the mixtape crew announcement to the Fluncle's Findings channel and return the
// exact text that was sent (the announce op echoes it back so the operator sees what
// went out). Mirrors postToTelegram; a non-2xx throws so the caller can release its
// idempotency claim and let the operator retry.
export async function postMixtapeToTelegram(mixtape: MixtapeDTO): Promise<string> {
  const text = formatMixtapeAnnouncement(mixtape);
  const env = await readEnvs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        // A mixtape post carries several links; keep Telegram from swelling it with a
        // link-preview card for each.
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
