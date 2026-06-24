import { type MixtapeDTO } from "@fluncle/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /calendar.ics route emits a hand-rolled VCALENDAR: future-planned mixtapes
// (incl. drafts — the teaser) as upcoming live-on-Twitch VEVENTs, published
// mixtapes as past /log events. We mock the server query and assert the .ics
// shape (escaping, CRLF, folding, the Twitch action, the draft-teaser surface).

const listCalendarMixtapes = vi.hoisted(() => vi.fn<(now: string) => Promise<MixtapeDTO[]>>());

vi.mock("../lib/server/mixtapes", () => ({ listCalendarMixtapes }));

const { Route } = await import("./calendar[.]ics");

function getHandler() {
  const handlers = Route.options.server?.handlers as
    | { GET: (ctx: unknown) => Promise<Response> }
    | undefined;
  if (!handlers) {
    throw new Error("calendar route has no GET handler");
  }
  return handlers.GET;
}

function mixtape(overrides: Partial<MixtapeDTO>): MixtapeDTO {
  return {
    artists: ["Fluncle"],
    externalUrls: {},
    memberCount: 0,
    members: [],
    status: "draft",
    title: "Fluncle Drum & Bass Mixtape",
    type: "mixtape",
    ...overrides,
  };
}

async function render(mixtapes: MixtapeDTO[]): Promise<string> {
  listCalendarMixtapes.mockResolvedValue(mixtapes);
  const response = await getHandler()({});
  return response.text();
}

const FUTURE = "2099-01-02T20:00:00.000Z";
const PAST = "2026-06-18T00:00:00.000Z";

describe("/calendar.ics", () => {
  beforeEach(() => {
    listCalendarMixtapes.mockReset();
  });

  it("serves a text/calendar VCALENDAR with CRLF line endings", async () => {
    listCalendarMixtapes.mockResolvedValue([]);
    const response = await getHandler()({});

    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("VERSION:2.0");
    expect(body).toContain("PRODID:");
    expect(body).toContain("END:VCALENDAR");
    // CRLF, not bare LF.
    expect(body).toContain("\r\n");
    expect(body.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });

  it("emits a future-planned draft as an upcoming live-on-Twitch event", async () => {
    const body = await render([
      mixtape({
        id: "draft-1",
        members: [
          { artists: ["Artist A"], durationMs: 1, title: "Tune A", trackId: "t1" } as never,
          { artists: ["Artist B"], durationMs: 1, title: "Tune B", trackId: "t2" } as never,
        ],
        plannedFor: FUTURE,
        status: "draft",
        title: "Fluncle Drum & Bass Mixtape",
      }),
    ]);

    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("DTSTART:20990102T200000Z");
    expect(body).toContain("SUMMARY:Fluncle Drum & Bass Mixtape");
    // The dated action is "tune in live on Twitch": URL + LOCATION are the channel.
    expect(body).toContain("URL:https://www.twitch.tv/flunclelive");
    expect(body).toContain("LOCATION:https://www.twitch.tv/flunclelive");
    // The teaser exposes the tracklist (folded lines re-joined for the assertion).
    const unfolded = body.replaceAll("\r\n ", "");
    expect(unfolded).toContain("Artist A — Tune A");
    expect(unfolded).toContain("Artist B — Tune B");
    // A future draft has a stable live UID.
    expect(body).toContain("UID:live-draft-1@fluncle.com");
  });

  it("emits a published mixtape as a past event pointing at its /log home", async () => {
    const body = await render([
      mixtape({
        id: "pub-1",
        logId: "020.F.1A",
        note: "A late checkpoint, dreamt.",
        recordedAt: PAST,
        status: "published",
        title: "Fluncle Drum & Bass Mixtape #1 | 020.F.1A",
      }),
    ]);

    const unfolded = body.replaceAll("\r\n ", "");
    expect(body).toContain("DTSTART:20260618T000000Z");
    // mixtapeDisplayTitle drops the " | <coordinate>" suffix for SUMMARY.
    expect(body).toContain("SUMMARY:Fluncle Drum & Bass Mixtape #1");
    expect(unfolded).toContain("https://www.fluncle.com/log/020.F.1A");
    expect(unfolded).toContain("A late checkpoint\\, dreamt.");
    expect(body).toContain("UID:mixtape-020.F.1A@fluncle.com");
  });

  it("escapes TEXT special characters per RFC 5545", async () => {
    const body = await render([
      mixtape({
        id: "pub-2",
        logId: "020.F.1B",
        note: "Comma, semicolon; backslash \\ and\na newline.",
        recordedAt: PAST,
        status: "published",
        title: "Title, with; specials",
      }),
    ]);

    const unfolded = body.replaceAll("\r\n ", "");
    expect(unfolded).toContain("SUMMARY:Title\\, with\\; specials");
    expect(unfolded).toContain("Comma\\, semicolon\\; backslash \\\\ and\\na newline.");
  });

  it("folds content lines to 75 octets with a leading-space continuation", async () => {
    const longNote = "x".repeat(400);
    const body = await render([
      mixtape({
        id: "pub-3",
        logId: "020.F.1C",
        note: longNote,
        recordedAt: PAST,
        status: "published",
        title: "Fluncle live",
      }),
    ]);

    for (const line of body.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // The folded note rejoins back to the original run of x's.
    expect(body.replaceAll("\r\n ", "")).toContain(longNote);
  });

  it("treats a planned date that is already past as a non-upcoming event", async () => {
    // A published mixtape whose `plannedFor` is in the past is NOT upcoming; it
    // falls through to the published past-event branch (dated by recordedAt).
    const body = await render([
      mixtape({
        id: "pub-4",
        logId: "020.F.1D",
        plannedFor: PAST,
        recordedAt: PAST,
        status: "published",
        title: "Fluncle Drum & Bass Mixtape #2 | 020.F.1D",
      }),
    ]);

    expect(body).toContain("UID:mixtape-020.F.1D@fluncle.com");
    expect(body).not.toContain("URL:https://www.twitch.tv/flunclelive");
  });
});
