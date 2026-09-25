import { createFileRoute } from "@tanstack/react-router";
import { type MixtapeDTO, type RecordingDTO } from "@fluncle/contracts";
import { logPageUrl, siteUrl, twitchUrl } from "../lib/fluncle-links";
import { mixtapeDisplayTitle } from "../lib/mixtapes";
import { listCalendarMixtapes } from "../lib/server/mixtapes";
import { listUpcomingPlans } from "../lib/server/recordings";

const PRODID = "-//Fluncle//Live Sessions//EN";
const CALENDAR_NAME = "Fluncle's live sessions";

export const Route = createFileRoute("/calendar.ics")({
  server: {
    handlers: {
      GET: async () => {
        const now = new Date();
        const [mixtapes, plans] = await Promise.all([
          listCalendarMixtapes(),
          listUpcomingPlans(now.toISOString()),
        ]);
        const dtstamp = toIcsUtc(now);

        const events = [
          ...plans
            .map((plan) => buildPlanEvent(plan, now, dtstamp))
            .filter((block): block is string[] => block !== null),
          ...mixtapes
            .map((mixtape) => buildMixtapeEvent(mixtape, dtstamp))
            .filter((block): block is string[] => block !== null),
        ].flat();

        const lines = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          `PRODID:${escapeText(PRODID)}`,
          "CALSCALE:GREGORIAN",
          "METHOD:PUBLISH",
          `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
          `X-WR-CALDESC:${escapeText(
            "Fluncle's live sessions, plus every mixtape he's left along the way. Subscribe and tune in.",
          )}`,
          ...events,
          "END:VCALENDAR",
        ];

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

function buildPlanEvent(plan: RecordingDTO, now: Date, dtstamp: string): string[] | null {
  const plannedFor = plan.plannedFor ? new Date(plan.plannedFor) : null;

  if (
    plannedFor === null ||
    Number.isNaN(plannedFor.getTime()) ||
    plannedFor.getTime() <= now.getTime()
  ) {
    return null;
  }

  const tracklist = formatCueTracklist(plan);
  const description = [
    "I'm going live on Twitch, mixing fresh drum & bass. Come through, cosmonauts.",
    tracklist ? `\n\nWhat's queued:\n${tracklist}` : "",
  ].join("");

  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(`live-${plan.id}@fluncle.com`)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsUtc(plannedFor)}`,
    "SUMMARY:Fluncle live",
    `URL:${escapeText(twitchUrl)}`,
    `LOCATION:${escapeText(twitchUrl)}`,
    `DESCRIPTION:${escapeText(description)}`,
    "END:VEVENT",
  ];
}

function buildMixtapeEvent(mixtape: MixtapeDTO, dtstamp: string): string[] | null {
  if (mixtape.status !== "published") {
    return null;
  }

  const recordedAt = mixtape.recordedAt ? new Date(mixtape.recordedAt) : null;
  if (recordedAt === null || Number.isNaN(recordedAt.getTime())) {
    return null;
  }

  const title = mixtapeDisplayTitle(mixtape.title) || "Fluncle live";
  const tracklist = formatMemberTracklist(mixtape);
  const link = mixtape.logId ? logPageUrl(mixtape.logId) : siteUrl;
  const description = [
    mixtape.note?.trim()
      ? mixtape.note.trim()
      : "I dreamt a stretch of findings into one long mix and left it here as a checkpoint. Put it on loud.",
    `\n\nListen: ${link}`,
    tracklist ? `\n\nTracklist:\n${tracklist}` : "",
  ].join("");

  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(eventUid(mixtape))}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsUtc(recordedAt)}`,
    `SUMMARY:${escapeText(title)}`,
    `URL:${escapeText(link)}`,
    `DESCRIPTION:${escapeText(description)}`,
    "END:VEVENT",
  ];
}

function eventUid(mixtape: MixtapeDTO): string {
  const anchor = mixtape.logId ?? mixtape.id ?? mixtape.title;
  return `mixtape-${anchor}@fluncle.com`;
}

function formatCueTracklist(plan: RecordingDTO): string {
  if (plan.tracklist.length === 0) {
    return "";
  }
  return plan.tracklist
    .map((cue) => (cue.artists.length > 0 ? `${cue.artists.join(", ")} — ${cue.title}` : cue.title))
    .join("\n");
}

function formatMemberTracklist(mixtape: MixtapeDTO): string {
  if (!mixtape.members || mixtape.members.length === 0) {
    return "";
  }
  return mixtape.members
    .map((member) => `${member.artists.join(", ")} — ${member.title}`)
    .join("\n");
}

function toIcsUtc(date: Date): string {
  return `${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\n");
}

function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) {
    return line;
  }

  const decoder = new TextDecoder();
  const segments: string[] = [];
  let start = 0;

  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);

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
