import { describe, expect, it } from "vitest";
import {
  type AttentionInputs,
  type AttentionItem,
  deadlineReadout,
  deriveAttentionItems,
  draftDeadline,
  formatAge,
  formatSpan,
  orderQueue,
  primaryFor,
  snoozeReadout,
  snoozeSlots,
  WORKING_SET_SIZE,
} from "./attention";

// The attention queue's pure model (lib/attention.ts) — the `/admin` home's
// mechanics, proven against an injected clock: the five sources' derivation and
// their partition, the ratified two-tier ordering, the bounded working set, the
// snooze/won't-do buckets, and the instrument readouts.

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (at: number) => new Date(at).toISOString();

const EMPTY_INPUTS: AttentionInputs = {
  artistReviews: [],
  clipPosts: [{ scheduledFor: iso(NOW + HOUR), status: "scheduled" }],
  clips: [],
  mixtapes: [],
  recordings: [],
  submissions: [],
};

const item = (overrides: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  anchorAt: iso(NOW - DAY),
  source: "post-tiktok",
  title: "IYRE — Glowing Embers",
  ...overrides,
});

describe("deriveAttentionItems", () => {
  it("derives nothing when every source is settled", () => {
    expect(deriveAttentionItems(EMPTY_INPUTS, NOW)).toEqual([]);
  });

  it("maps a pending TikTok draft to a deadline row 24h off its push time", () => {
    const pushedAt = iso(NOW - 2 * HOUR);
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        clips: [
          {
            addedAt: iso(NOW - 3 * DAY),
            artUrl: "https://img/cover.jpg",
            artists: ["IYRE"],
            logId: "020.2.3Y",
            tiktokStatus: "draft",
            tiktokUpdatedAt: pushedAt,
            title: "Glowing Embers",
            trackId: "t1",
            // YouTube already up, so the only pending leg is the TikTok draft.
            youtubeStatus: "published",
          },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      deadlineAt: draftDeadline(pushedAt),
      id: "tiktok-draft:t1",
      logId: "020.2.3Y",
      source: "tiktok-draft",
      title: "IYRE — Glowing Embers",
      trackId: "t1",
    });
    expect(Date.parse(draftDeadline(pushedAt))).toBe(Date.parse(pushedAt) + DAY);
  });

  it("splits the oldest clip into its two pending platform legs, each carrying the waiting count", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        clips: [
          {
            addedAt: iso(NOW - 17 * DAY),
            artists: ["A"],
            logId: "l1",
            title: "One",
            trackId: "t1",
          },
          { addedAt: iso(NOW - 3 * DAY), artists: ["B"], logId: "l2", title: "Two", trackId: "t2" },
          { addedAt: iso(NOW - DAY), artists: ["C"], logId: "l3", title: "Three", trackId: "t3" },
        ],
      },
      NOW,
    );

    // Only the oldest clip (t1) surfaces — its TikTok and YouTube legs, both pending; the
    // waiting count is every clip still needing work.
    expect(items.map((entry) => entry.id)).toEqual(["post-tiktok:t1", "post-youtube:t1"]);
    expect(items.every((entry) => entry.waiting === 3)).toBe(true);
  });

  it("shows only the pending leg when the other is already posted", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        clips: [
          {
            addedAt: iso(NOW - 3 * DAY),
            artists: ["A"],
            logId: "l1",
            // TikTok is live already; only the YouTube leg is pending.
            tiktokStatus: "published",
            title: "One",
            trackId: "t1",
          },
        ],
      },
      NOW,
    );

    expect(items.map((entry) => entry.id)).toEqual(["post-youtube:t1"]);
  });

  it("keeps a clip off the queue once both legs have landed", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        clips: [
          {
            addedAt: iso(NOW - 3 * DAY),
            artists: ["A"],
            tiktokStatus: "published",
            title: "Done",
            trackId: "t1",
            youtubeStatus: "published",
          },
          { addedAt: iso(NOW - DAY), artists: ["B"], logId: "l2", title: "Next", trackId: "t2" },
        ],
      },
      NOW,
    );

    // t1 is fully distributed, so t2 becomes the focus.
    expect(items.map((entry) => entry.id)).toEqual(["post-tiktok:t2", "post-youtube:t2"]);
  });

  it("shows an in-flight TikTok draft as a deadline row even behind the one-clip gate", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        clips: [
          // The focus clip: both legs fresh.
          {
            addedAt: iso(NOW - 17 * DAY),
            artists: ["A"],
            logId: "l1",
            title: "One",
            trackId: "t1",
          },
          // A newer clip whose TikTok draft is already racing its bounce — must still show.
          {
            addedAt: iso(NOW - 3 * DAY),
            artists: ["B"],
            logId: "l2",
            tiktokStatus: "draft",
            tiktokUpdatedAt: iso(NOW - 30 * HOUR),
            title: "Two",
            trackId: "t2",
            youtubeStatus: "published",
          },
        ],
      },
      NOW,
    );

    const ids = items.map((entry) => entry.id);
    expect(ids).toContain("tiktok-draft:t2");
    expect(ids).toContain("post-tiktok:t1");
    expect(ids).toContain("post-youtube:t1");
    // t2's TikTok is a draft (its own deadline row), never also a fresh post-tiktok.
    expect(ids).not.toContain("post-tiktok:t2");
  });

  it("surfaces a videoless-cue take, deep-linked to its Studio and M2-badged", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        recordings: [
          // A plan (no video) never rows; a promoted take is the mixtape's business;
          // a take with cues is settled; only the cue-less take surfaces.
          {
            createdAt: iso(NOW - DAY),
            hasVideo: false,
            id: "plan",
            title: "Plan",
            tracklistLength: 0,
          },
          {
            createdAt: iso(NOW - DAY),
            hasVideo: true,
            id: "promoted",
            mixtapeId: "m1",
            title: "Promoted",
            tracklistLength: 0,
          },
          {
            createdAt: iso(NOW - DAY),
            hasVideo: true,
            id: "cued",
            title: "Cued",
            tracklistLength: 12,
          },
          {
            createdAt: iso(NOW - 2 * DAY),
            hasVideo: true,
            id: "raw",
            title: "Raw take",
            tracklistLength: 0,
          },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      href: "/admin/studio/raw",
      id: "attach-cues:raw",
      machine: "M2",
      source: "attach-cues",
    });
  });

  it("surfaces a distributing mixtape with its missing legs, M5-badged", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        mixtapes: [
          {
            anchorAt: iso(NOW - 2 * DAY),
            id: "m1",
            logId: "017.F.02",
            recordingId: "r1",
            status: "distributing",
            title: "Fluncle Drum & Bass Mixtape 2",
            youtubeUrl: "https://youtu.be/x",
          },
          { id: "m2", status: "published", title: "Done" },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      href: "/admin/studio/r1",
      id: "distribute:m1",
      machine: "M5",
      missing: ["mixcloud"],
      source: "distribute",
    });
  });

  it("rows the empty drip, anchored to the last slot that fired", () => {
    const lastSlot = iso(NOW - 3 * DAY);
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        clipPosts: [
          { scheduledFor: lastSlot, status: "posted" },
          { scheduledFor: iso(NOW - 5 * DAY), status: "posted" },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      anchorAt: lastSlot,
      href: "/admin/clips",
      id: "drip-empty",
      source: "drip-empty",
    });
  });

  it("keeps the drip row off while anything is still scheduled", () => {
    expect(deriveAttentionItems(EMPTY_INPUTS, NOW)).toEqual([]);
  });

  it("rows each artist needing a look, deep-linked to /admin/artists focused, with the count", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        artistReviews: [
          { anchorAt: iso(NOW - 2 * DAY), artistId: "a1", name: "Aktive", pending: 3 },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      anchorAt: iso(NOW - 2 * DAY),
      href: "/admin/artists?artist=a1",
      id: "artist-review:a1",
      reviewLinks: 3,
      source: "artist-review",
      title: "Aktive",
    });
  });

  it("rows each pending submission oldest-first, deep-linked to the exact review-tray candidate", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        submissions: [
          {
            artUrl: "https://img/sub.jpg",
            artists: ["Calibre"],
            createdAt: iso(NOW - 5 * HOUR),
            id: "sub-1",
            title: "Mr Right On",
            triageVerdict: "looks like a find — Calibre, not yet logged",
          },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      anchorAt: iso(NOW - 5 * HOUR),
      artUrl: "https://img/sub.jpg",
      href: "/admin/findings?submission=sub-1",
      id: "submission:sub-1",
      source: "submission",
      title: "Calibre — Mr Right On",
      verdict: "looks like a find — Calibre, not yet logged",
    });
  });

  it("omits the verdict on a submission the pre-chew sweep has not visited yet", () => {
    const items = deriveAttentionItems(
      {
        ...EMPTY_INPUTS,
        submissions: [
          { artists: ["Nu:Tone"], createdAt: iso(NOW - HOUR), id: "sub-2", title: "Falling" },
        ],
      },
      NOW,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.verdict).toBeUndefined();
    expect(items[0]).toMatchObject({ id: "submission:sub-2", source: "submission" });
  });
});

describe("orderQueue", () => {
  it("orders deadline rows by time-to-deadline ahead of everything else", () => {
    const rows = [
      item({ anchorAt: iso(NOW - 30 * DAY), id: "old" }),
      item({ deadlineAt: iso(NOW + 6 * HOUR), id: "soon", source: "tiktok-draft" }),
      item({ deadlineAt: iso(NOW - 2 * HOUR), id: "bounced", source: "tiktok-draft" }),
      item({ anchorAt: iso(NOW - 2 * DAY), id: "young" }),
    ];

    const { due } = orderQueue(rows, {}, NOW);

    expect(due.map((entry) => entry.id)).toEqual(["bounced", "soon", "old", "young"]);
  });

  it("bounds the working set and ages the rest into the backlog", () => {
    const rows = Array.from({ length: WORKING_SET_SIZE + 3 }, (_, index) =>
      item({ anchorAt: iso(NOW - (index + 1) * DAY), id: `row-${index}` }),
    );

    const { backlog, due } = orderQueue(rows, {}, NOW);

    expect(due).toHaveLength(WORKING_SET_SIZE);
    expect(backlog).toHaveLength(3);
    // Oldest-first: the oldest anchors fill the working set.
    expect(due[0]?.id).toBe(`row-${WORKING_SET_SIZE + 2}`);
  });

  it("buckets snoozes until they expire, and won't-do rows permanently", () => {
    const rows = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    const prefs = {
      a: { snoozedUntil: iso(NOW + HOUR) },
      b: { snoozedUntil: iso(NOW - HOUR) },
      c: { wontDoAt: iso(NOW - DAY) },
    };

    const { dismissed, due, snoozed } = orderQueue(rows, prefs, NOW);

    expect(snoozed.map((entry) => entry.id)).toEqual(["a"]);
    // An expired snooze re-enters on its own.
    expect(due.map((entry) => entry.id)).toEqual(["b"]);
    expect(dismissed.map((entry) => entry.id)).toEqual(["c"]);
  });
});

describe("the readouts", () => {
  it("formats spans at the shortest honest unit", () => {
    expect(formatSpan(17 * DAY + 3 * HOUR)).toBe("17d");
    expect(formatSpan(3 * HOUR)).toBe("3h");
    expect(formatSpan(12 * 60_000)).toBe("12m");
    expect(formatSpan(-5)).toBe("0m");
  });

  it("ages a row off its anchor", () => {
    expect(formatAge(iso(NOW - 17 * DAY), NOW)).toBe("17d");
    expect(formatAge("not-a-date", NOW)).toBe("0m");
  });

  it("reads a live deadline as time left and a passed one as bounced", () => {
    expect(deadlineReadout(iso(NOW + 6 * HOUR), NOW)).toEqual({
      label: "6h left",
      overdue: false,
    });
    expect(deadlineReadout(iso(NOW - 3 * HOUR), NOW)).toEqual({
      label: "bounced 3h",
      overdue: true,
    });
  });

  it("reads a snooze as its until-time (the shared 9:00 clock format)", () => {
    expect(snoozeReadout(iso(NOW + 2 * HOUR), NOW)).toMatch(/^until \d{1,2}:\d{2}$/);
    expect(snoozeReadout(iso(NOW + 3 * DAY), NOW)).toMatch(/^until \w{3} \d{1,2}:\d{2}$/);
  });
});

describe("snoozeSlots", () => {
  it("offers three future slots, the fixed +3h first", () => {
    const slots = snoozeSlots(NOW);

    expect(slots).toHaveLength(3);
    expect(Date.parse(slots[0]?.until ?? "")).toBe(NOW + 3 * HOUR);
    for (const slot of slots) {
      expect(Date.parse(slot.until)).toBeGreaterThan(NOW);
    }
    // The two nine-o'clock slots land at 09:00 local.
    for (const slot of slots.slice(1)) {
      expect(new Date(slot.until).getHours()).toBe(9);
      expect(new Date(slot.until).getMinutes()).toBe(0);
    }
  });

  it("rolls a full week when today is the target weekday", () => {
    // NOW is a Monday (2026-07-06); "Mon 9:00" must be NEXT Monday.
    const monday = snoozeSlots(NOW)[2];
    const until = new Date(monday?.until ?? "");

    expect(until.getDay()).toBe(1);
    expect(until.getTime() - NOW).toBeGreaterThan(6 * DAY);
  });
});

describe("primaryFor", () => {
  it("pushes the platform's video for a fresh post row", () => {
    expect(primaryFor(item({ id: "p", source: "post-tiktok" }), NOW)).toEqual({
      kind: "push",
      label: "Push draft",
      platform: "tiktok",
    });
    expect(primaryFor(item({ id: "y", source: "post-youtube" }), NOW)).toEqual({
      kind: "push",
      label: "Post to YouTube",
      platform: "youtube",
    });
  });

  it("copies the caption for a fresh TikTok draft you finish in-app", () => {
    expect(
      primaryFor(item({ deadlineAt: iso(NOW + HOUR), id: "d", source: "tiktok-draft" }), NOW).kind,
    ).toBe("copy-caption");
  });

  it("re-pushes a bounced draft", () => {
    expect(
      primaryFor(item({ deadlineAt: iso(NOW - HOUR), id: "d", source: "tiktok-draft" }), NOW).kind,
    ).toBe("re-push");
  });

  it("deep-links the Studio-, plans-, and clips-owned actions", () => {
    expect(
      primaryFor(item({ href: "/admin/studio/r1", id: "c", source: "attach-cues" }), NOW),
    ).toEqual({ href: "/admin/studio/r1", kind: "open", label: "Attach cues" });
    expect(primaryFor(item({ id: "x", source: "distribute" }), NOW)).toEqual({
      href: "/admin/plans",
      kind: "open",
      label: "Distribute",
    });
    expect(primaryFor(item({ id: "drip-empty", source: "drip-empty" }), NOW)).toEqual({
      href: "/admin/clips",
      kind: "open",
      label: "Cut clips",
    });
  });

  it("routes an artist-review row to its focused /admin/artists deep-link", () => {
    expect(
      primaryFor(item({ href: "/admin/artists?artist=a1", id: "a", source: "artist-review" }), NOW),
    ).toEqual({ href: "/admin/artists?artist=a1", kind: "open", label: "Review" });
  });

  it("routes a submission row to its review-tray deep-link (never an inline decision)", () => {
    expect(
      primaryFor(
        item({ href: "/admin/findings?submission=sub-1", id: "s", source: "submission" }),
        NOW,
      ),
    ).toEqual({ href: "/admin/findings?submission=sub-1", kind: "open", label: "Review" });
  });
});
