import { createFileRoute } from "@tanstack/react-router";
import { type MixtapeDTO } from "@fluncle/contracts";
import { logPageUrl, siteUrl, twitchUrl } from "../lib/fluncle-links";
import { mixtapeDisplayTitle } from "../lib/mixtapes";
import { listCalendarMixtapes } from "../lib/server/mixtapes";

// A subscribe-able calendar (RFC 5545) of Fluncle's live sessions. Two kinds of
// VEVENT:
//   - upcoming live sessions: any mixtape with a FUTURE `plannedFor` (including
//     drafts — the teaser). The dated action is "tune in live on Twitch", so the
//     event's URL/LOCATION is the Twitch channel.
//   - past mixtapes: every `published` mixtape, dated by `recordedAt`, pointing
//     at its permanent /log home.
//
// A draft WITHOUT `plannedFor` is neither published nor future-planned, so the
// query (listCalendarMixtapes) never returns it — unannounced drafts stay hidden.
// A future-planned draft exposes ONLY its title, date, and tracklist here; the
// teaser is intentional.

const PRODID = "-//Fluncle//Live Sessions//EN";
const CALENDAR_NAME = "Fluncle — Live Sessions";

export const Route = createFileRoute("/calendar.ics")({
  server: {
    handlers: {
      GET: async () => {
        const now = new Date();
        const mixtapes = await listCalendarMixtapes(now.toISOString());
        const dtstamp = toIcsUtc(now);

        const events = mixtapes
          .map((mixtape) => buildEvent(mixtape, now, dtstamp))
          .filter((block): block is string[] => block !== null)
          .flat();

        const lines = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          `PRODID:${escapeText(PRODID)}`,
          "CALSCALE:GREGORIAN",
          "METHOD:PUBLISH",
          `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
          `X-WR-CALDESC:${escapeText(
            "When Fluncle goes live and the mixtapes he settled along the way. Subscribe and tune in.",
          )}`,
          ...events,
          "END:VCALENDAR",
        ];

        // Fold every line to ≤75 octets, then join with CRLF (RFC 5545 §3.1).
        const body = `${lines.map(foldLine).join("\r\n")}\r\n`;

        return new Response(body, {
          headers: {
            "Cache-Control": "public, max-age=300",
            "Content-Type": "text/calendar; charset=utf-8",
          },
        });
      },
    },
  },
});

// One mixtape → its VEVENT lines, or null when it has no datable anchor. A future
// `plannedFor` makes it an upcoming live session; otherwise a published mixtape is
// a past event.
function buildEvent(mixtape: MixtapeDTO, now: Date, dtstamp: string): string[] | null {
  const title = mixtapeDisplayTitle(mixtape.title) || "Fluncle live";
  const tracklist = formatTracklist(mixtape);

  const plannedFor = mixtape.plannedFor ? new Date(mixtape.plannedFor) : null;
  const isUpcoming =
    plannedFor !== null &&
    !Number.isNaN(plannedFor.getTime()) &&
    plannedFor.getTime() > now.getTime();

  if (isUpcoming) {
    // An upcoming live session: the action is "tune in live on Twitch", so the
    // Twitch channel is the URL + LOCATION. A draft teaser lands here.
    const description = [
      "Fluncle goes live — fresh drum & bass, mixed live across the Galaxy. Tune in on Twitch.",
      tracklist ? `\n\nWhat's queued:\n${tracklist}` : "",
    ].join("");

    return [
      "BEGIN:VEVENT",
      `UID:${escapeText(eventUid(mixtape, "live"))}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${toIcsUtc(plannedFor)}`,
      `SUMMARY:${escapeText(title)}`,
      `URL:${escapeText(twitchUrl)}`,
      `LOCATION:${escapeText(twitchUrl)}`,
      `DESCRIPTION:${escapeText(description)}`,
      "END:VEVENT",
    ];
  }

  // A past event: only `published` mixtapes (the query guarantees it) with a
  // recorded date. Point at the permanent /log home.
  if (mixtape.status !== "published") {
    return null;
  }

  const recordedAt = mixtape.recordedAt ? new Date(mixtape.recordedAt) : null;
  if (recordedAt === null || Number.isNaN(recordedAt.getTime())) {
    return null;
  }

  const link = mixtape.logId ? logPageUrl(mixtape.logId) : siteUrl;
  const description = [
    mixtape.note?.trim()
      ? mixtape.note.trim()
      : "A checkpoint Fluncle settled along the way — a stretch of findings dreamt into one long mix.",
    `\n\nListen: ${link}`,
    tracklist ? `\n\nTracklist:\n${tracklist}` : "",
  ].join("");

  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(eventUid(mixtape, "mixtape"))}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsUtc(recordedAt)}`,
    `SUMMARY:${escapeText(title)}`,
    `URL:${escapeText(link)}`,
    `DESCRIPTION:${escapeText(description)}`,
    "END:VEVENT",
  ];
}

// A stable, globally-unique UID (RFC 5545 §3.8.4.7). The kind keeps a single
// mixtape's live-session event and (later) mixtape event distinct.
function eventUid(mixtape: MixtapeDTO, kind: "live" | "mixtape"): string {
  const anchor = mixtape.logId ?? mixtape.id ?? mixtape.title;
  return `${kind}-${anchor}@fluncle.com`;
}

// The member list as "Artist — Title" lines (no offsets), for the DESCRIPTION.
function formatTracklist(mixtape: MixtapeDTO): string {
  if (!mixtape.members || mixtape.members.length === 0) {
    return "";
  }
  return mixtape.members
    .map((member) => `${member.artists.join(", ")} — ${member.title}`)
    .join("\n");
}

// A Date → the RFC 5545 UTC date-time form (YYYYMMDDTHHMMSSZ).
function toIcsUtc(date: Date): string {
  return `${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

// Escape a TEXT value per RFC 5545 §3.3.11: backslash, then semicolon, comma, and
// newlines (CR is dropped). Order matters so the backslash escape doesn't double up.
function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\n");
}

// Fold a content line to ≤75 octets (RFC 5545 §3.1): a continuation begins with a
// single space. We fold on octet boundaries (UTF-8 aware) so multi-byte chars are
// never split.
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) {
    return line;
  }

  const decoder = new TextDecoder();
  const segments: string[] = [];
  let start = 0;
  // First segment: 75 octets. Continuations: 74 octets (the leading space counts).
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Don't split a UTF-8 multi-byte sequence: back off while the next byte is a
    // continuation byte (0b10xxxxxx). The `end < bytes.length` guard keeps the
    // index in bounds, so the byte is always present here.
    let nextByte = bytes[end];
    while (nextByte !== undefined && end < bytes.length && (nextByte & 0xc0) === 0x80) {
      end -= 1;
      nextByte = bytes[end];
    }
    segments.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = 74;
  }

  return segments.join("\r\n ");
}
