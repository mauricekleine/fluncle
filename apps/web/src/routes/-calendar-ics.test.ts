import { type MixtapeDTO, type RecordingDTO } from "@fluncle/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /calendar.ics route emits a hand-rolled VCALENDAR: future-planned PLANS
// (a videoless recording with a future `plannedFor`) as upcoming live-on-Twitch
// VEVENTs, published mixtapes as past /log events. We mock both server queries and
// assert the .ics shape (escaping, CRLF, folding, the Twitch action, the plan teaser).
// Upcoming sessions come from the PLAN side since the plan→recording→mixtape Deploy-2
// cutover dropped `mixtapes.planned_for`.

const listCalendarMixtapes = vi.hoisted(() => vi.fn<() => Promise<MixtapeDTO[]>>());
const listUpcomingPlans = vi.hoisted(() => vi.fn<(now: string) => Promise<RecordingDTO[]>>());

vi.mock("../lib/server/mixtapes", () => ({ listCalendarMixtapes }));
vi.mock("../lib/server/recordings", () => ({ listUpcomingPlans }));

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
    status: "published",
    title: "Fluncle Drum & Bass Mixtape",
    type: "mixtape",
    ...overrides,
  };
}

function plan(overrides: Partial<RecordingDTO>): RecordingDTO {
  return {
    createdAt: "2026-06-18T00:00:00.000Z",
    hasVideo: false,
    id: "plan-1",
    title: "liquid-nebula-roller",
    tracklist: [],
    updatedAt: "2026-06-18T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

async function render(mixtapes: MixtapeDTO[], plans: RecordingDTO[] = []): Promise<string> {
  listCalendarMixtapes.mockResolvedValue(mixtapes);
  listUpcomingPlans.mockResolvedValue(plans);
  const response = await getHandler()({});
  return response.text();
}

const FUTURE = "2099-01-02T20:00:00.000Z";
const PAST = "2026-06-18T00:00:00.000Z";

describe("/calendar.ics", () => {
  beforeEach(() => {
    listCalendarMixtapes.mockReset();
    listUpcomingPlans.mockReset();
  });

  it("serves a text/calendar VCALENDAR with CRLF line endings", async () => {
    listCalendarMixtapes.mockResolvedValue([]);
    listUpcomingPlans.mockResolvedValue([]);
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

  it("emits a future-planned PLAN as an upcoming live-on-Twitch event", async () => {
    const body = await render(
      [],
      [
        plan({
          id: "plan-1",
          plannedFor: FUTURE,
          tracklist: [
            { artists: ["Artist A"], id: "c1", title: "Tune A" },
            { artists: ["Artist B"], id: "c2", title: "Tune B" },
          ],
        }),
      ],
    );

    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("DTSTART:20990102T200000Z");
    // The plan's internal handle never appears — the public SUMMARY is quiet.
    expect(body).toContain("SUMMARY:Fluncle live");
    expect(body).not.toContain("liquid-nebula-roller");
    // The dated action is "tune in live on Twitch": URL + LOCATION are the channel.
    expect(body).toContain("URL:https://www.twitch.tv/flunclelive");
    expect(body).toContain("LOCATION:https://www.twitch.tv/flunclelive");
    // The teaser exposes the queued tracklist (folded lines re-joined for the assertion).
    const unfolded = body.replaceAll("\r\n ", "");
    expect(unfolded).toContain("Artist A — Tune A");
    expect(unfolded).toContain("Artist B — Tune B");
    // A future plan has a stable live UID keyed off its recording id.
    expect(body).toContain("UID:live-plan-1@fluncle.com");
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

  it("omits a published mixtape with no recorded date (no datable anchor)", async () => {
    const body = await render([
      mixtape({ id: "pub-4", logId: "020.F.1D", recordedAt: undefined, status: "published" }),
    ]);

    expect(body).not.toContain("BEGIN:VEVENT");
  });
});
