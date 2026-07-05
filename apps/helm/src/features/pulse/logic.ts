// pulse — the pure core. Every decision the board and the nudge rest on lives here
// as a plain function over plain data: no fetch, no Bun, no DOM, no clock of its
// own. The server (server.ts) and the scheduler (scheduler.ts) feed it real data;
// the tests (logic.test.ts) feed it fixtures with an injected clock. Keeping it
// pure is what lets the 18h nudge be proven without waiting 18 hours.
//
// These types are also the wire shape the panel reads — the daemon serialises them
// straight to the glass, so a field named here is a field the panel can render.

// ─── The render queue ────────────────────────────────────────────────────────

/** One awaiting finding on the render queue (no video yet), as the panel shows it. */
export type QueueRow = {
  /** Age of the finding in whole minutes at read time — the panel formats it. */
  ageMinutes: number;
  artistTitle: string;
  logId: string;
};

/** The minimal admin-track fields the queue mapping needs (a subset of TrackListItem). */
export type QueueTrackInput = {
  addedAt: string;
  artists: string[];
  logId?: string;
  title: string;
};

/** "Artist A & Artist B — Title", the one-line finding label used across the board. */
export function artistTitle(artists: string[], title: string): string {
  const who = artists.filter((name) => name.trim().length > 0).join(" & ");

  return who.length > 0 ? `${who} — ${title}` : title;
}

/** Whole minutes between an ISO timestamp and `now`, floored at zero (never negative). */
export function minutesSince(iso: string, now: number): number {
  const then = Date.parse(iso);

  if (Number.isNaN(then)) {
    return 0;
  }

  return Math.max(0, Math.floor((now - then) / 60_000));
}

/**
 * Map raw admin findings (oldest first — the render queue's order) to queue rows.
 * A finding with no Log ID is dropped: without a coordinate it has no place on the
 * board (and the video pipeline gates on it anyway).
 */
export function mapQueue(tracks: QueueTrackInput[], now: number): QueueRow[] {
  const rows: QueueRow[] = [];

  for (const track of tracks) {
    if (!track.logId) {
      continue;
    }

    rows.push({
      ageMinutes: minutesSince(track.addedAt, now),
      artistTitle: artistTitle(track.artists, track.title),
      logId: track.logId,
    });
  }

  return rows;
}

// ─── Next to post ────────────────────────────────────────────────────────────

/**
 * A video'd finding plus whether it's already gone to TikTok. `postedAt` is the ms
 * epoch of its freshest in-flight/done post (any platform), or null when nothing
 * has been pushed — the two signals the next-to-post pick and the nudge both read.
 */
export type PostingCandidate = {
  addedAt: string;
  artists: string[];
  logId: string;
  /** True when a TikTok post exists that is drafted, scheduled, or published. */
  postedToTikTok: boolean;
  /** Freshest post time across ALL platforms (ms epoch), or null if never posted. */
  postedAt: number | null;
  title: string;
};

/**
 * The operator's single next thing to post: the OLDEST video'd finding not yet on
 * TikTok. Oldest-first is deliberate — a filmed finding shouldn't rot unposted, and
 * "dressed and waiting" (the nudge) reads as the one that's waited longest. Returns
 * `undefined` when every candidate has already gone out.
 */
export function selectNextToPost(candidates: PostingCandidate[]): PostingCandidate | undefined {
  return candidates
    .filter((candidate) => !candidate.postedToTikTok)
    .sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt))[0];
}

/** The freshest "we posted something" moment across the window, or null if none. */
export function newestPostedAt(candidates: PostingCandidate[]): number | null {
  let newest: number | null = null;

  for (const candidate of candidates) {
    if (candidate.postedAt !== null && (newest === null || candidate.postedAt > newest)) {
      newest = candidate.postedAt;
    }
  }

  return newest;
}

/** One `social_posts` row, trimmed to what freshness reads. */
export type PostRecord = {
  createdAt?: string;
  platform: string;
  publishedAt?: string;
  status: string;
  updatedAt?: string;
};

// A post counts as "gone out" once it's drafted, scheduled, or published — a TikTok
// draft is already in the inbox, a scheduled post is committed. A `failed` (or any
// other) status re-opens the finding as unposted.
const LIVE_POST_STATUSES = new Set(["draft", "published", "scheduled"]);

/**
 * Read a finding's per-platform posts into the two signals the board needs:
 * whether it has already gone to TikTok, and the freshest "we posted something"
 * moment across ALL platforms (the nudge's staleness clock). Pure over the rows.
 */
export function postFreshness(posts: PostRecord[]): {
  postedAt: number | null;
  postedToTikTok: boolean;
} {
  let postedToTikTok = false;
  let postedAt: number | null = null;

  for (const post of posts) {
    if (!LIVE_POST_STATUSES.has(post.status)) {
      continue;
    }

    if (post.platform === "tiktok") {
      postedToTikTok = true;
    }

    const stamp = post.publishedAt ?? post.updatedAt ?? post.createdAt;
    const at = stamp ? Date.parse(stamp) : Number.NaN;

    if (!Number.isNaN(at) && (postedAt === null || at > postedAt)) {
      postedAt = at;
    }
  }

  return { postedAt, postedToTikTok };
}

// ─── The status probe ────────────────────────────────────────────────────────

/** The three-state service-health enum the public /api/status endpoint emits. */
export type ServiceHealth = "degraded" | "down" | "ok";

/** One service row, trimmed to what the pulse board renders. */
export type SurfaceRow = {
  latencyMs: number | null;
  message: string | null;
  service: string;
  status: ServiceHealth;
};

/** The shape of /api/status the mapper reads (a subset of the public payload). */
export type StatusProbeInput = {
  freshestReportAt?: string | null;
  services?: Array<{
    latencyMs?: number | null;
    message?: string | null;
    service: string;
    status: string;
  }>;
};

const HEALTH_VALUES = new Set<ServiceHealth>(["degraded", "down", "ok"]);

function toHealth(value: string): ServiceHealth {
  return HEALTH_VALUES.has(value as ServiceHealth) ? (value as ServiceHealth) : "down";
}

/** Map the public status payload to the board's surface rows, order preserved. */
export function mapSurfaces(input: StatusProbeInput): SurfaceRow[] {
  return (input.services ?? []).map((service) => ({
    latencyMs: service.latencyMs ?? null,
    message: service.message ?? null,
    service: service.service,
    status: toHealth(service.status),
  }));
}

/** A one-glance count of how the surfaces are doing — for the section header. */
export function surfaceTally(rows: SurfaceRow[]): { degraded: number; down: number; ok: number } {
  const tally = { degraded: 0, down: 0, ok: 0 };

  for (const row of rows) {
    tally[row.status] += 1;
  }

  return tally;
}

// ─── The 18h nudge ───────────────────────────────────────────────────────────

/** Everything the nudge decision reads — no ambient clock, no I/O. */
export type NudgeInput = {
  /** Whether an unposted, video'd finding exists (nudging with nothing is pointless). */
  hasUnposted: boolean;
  /** Per-day dedupe key of the last nudge already sent (a `dayKey`), or null. */
  lastNudgeDay: string | null;
  /** The finding label for the notification body ("Artist — Title"). */
  nextLabel: string | null;
  /** The freshest "we posted something" moment (ms epoch), or null if never. */
  newestPostedAt: number | null;
  /** The injected clock — `Date.now()` in production, a fixture in tests. */
  now: number;
  /** The staleness threshold in hours (FLUNCLE_HELM_NUDGE_HOURS, default 18). */
  thresholdHours: number;
  /** IANA zone the per-day dedupe is computed in (the operator's local day). */
  timeZone: string;
};

/** Why the nudge did or didn't fire — surfaced on the panel and returned by the check. */
export type NudgeReason = "already-nudged-today" | "fresh" | "no-unposted" | "stale";

export type NudgeDecision =
  | { ageMs: number | null; fire: false; reason: "already-nudged-today" | "fresh" | "no-unposted" }
  | {
      ageMs: number | null;
      body: string;
      fire: true;
      nudgeDay: string;
      reason: "stale";
      title: string;
    };

/** The operator's local day as `YYYY-MM-DD` — the nudge's once-a-day dedupe key. */
export function dayKey(now: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD; the zone makes "today" the operator's local day.
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(new Date(now));
}

/**
 * The nudge tick — the whole 18h decision in one pure function.
 *
 *   1. Nothing unposted → never nudge (there's nothing to nag about).
 *   2. The last post is younger than the threshold → too fresh, hold.
 *   3. Already nudged today (same local day) → hold, no nag storms.
 *   4. Otherwise fire once, and hand back the day key so the caller can dedupe.
 *
 * A null `newestPostedAt` (nothing has ever gone out, but a render waits) counts as
 * infinitely stale — the backlog is real, so the nudge is earned.
 */
export function nudgeTick(input: NudgeInput): NudgeDecision {
  const ageMs =
    input.newestPostedAt === null ? null : Math.max(0, input.now - input.newestPostedAt);

  if (!input.hasUnposted) {
    return { ageMs, fire: false, reason: "no-unposted" };
  }

  const thresholdMs = input.thresholdHours * 3_600_000;
  const stale = ageMs === null || ageMs >= thresholdMs;

  if (!stale) {
    return { ageMs, fire: false, reason: "fresh" };
  }

  const nudgeDay = dayKey(input.now, input.timeZone);

  if (input.lastNudgeDay === nudgeDay) {
    return { ageMs, fire: false, reason: "already-nudged-today" };
  }

  const label = input.nextLabel ?? "A finding";
  const body =
    ageMs === null
      ? "Dressed and waiting — nothing's gone out yet."
      : `Dressed and waiting — ${Math.round(ageMs / 3_600_000)}h since the last post.`;

  return { ageMs, body, fire: true, nudgeDay, reason: "stale", title: label };
}
