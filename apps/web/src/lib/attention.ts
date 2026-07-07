// The attention queue's pure model (docs/planning/cockpit-roadmap.md, "The queue"). Every
// decision the `/admin` home makes — which rows exist, which tier they ride, what
// order they land in, what the working set is, what a deadline reads as — lives
// here as plain functions over plain data with an injected clock, so the queue's
// mechanics are provable without a database or a browser (the track-stage.ts /
// helm pulse precedent). The server (lib/server/attention.ts) feeds `derive*` real
// rows; the route feeds `orderQueue` the operator's snooze/won't-do prefs.
//
// The two-tier ordering is ratified: DEADLINE rows (a TikTok inbox draft racing
// its 24h bounce) sort by time-to-deadline, everything else oldest-first. The
// bounded working set keeps zero winnable: the top rows count toward zero, the
// rest age into a backlog behind [Show all].

import { TIKTOK_DRAFT_STALE_MS, trackLabel } from "@fluncle/contracts/util";

// ─── The rows ────────────────────────────────────────────────────────────────

/** The queue sources (the roadmap's data-honesty-verified EXISTS set). */
export type AttentionSource =
  | "artist-review"
  | "attach-cues"
  | "distribute"
  | "drip-empty"
  | "post-tiktok"
  | "tiktok-draft";

/** One row of the queue — artwork, the object line, data, and action routing. */
export type AttentionItem = {
  /** The oldest-first anchor (when this became the system's business). */
  anchorAt: string;
  /** Cover art / mixtape cover; absent ⇒ the glyph tile (a recording has no cover). */
  artUrl?: string;
  /** Present ⇒ the row rides the deadline tier, ordered by time-to-deadline. */
  deadlineAt?: string;
  /** The deep-link target when the primary action navigates. */
  href?: string;
  /** Stable identity (`source:objectId`) — the snooze/won't-do map keys on it. */
  id: string;
  logId?: string;
  /** The machine an action is bound to (docs/planning/cockpit-roadmap.md, the machine model). */
  machine?: "M2" | "M5";
  /** Distribution legs still missing on a promoted mixtape. */
  missing?: ("mixcloud" | "youtube")[];
  /** Artist-review rows: how many of an artist's socials still need a look. */
  reviewLinks?: number;
  source: AttentionSource;
  title: string;
  trackId?: string;
  /** How many dressed findings wait behind this one (the post-tiktok row's datum). */
  waiting?: number;
};

// ─── Derivation (server-fed row shapes → items) ─────────────────────────────

/** A pending TikTok inbox draft joined to its finding. */
export type DraftInput = {
  artUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
  /** The push / re-push time — the 24h bounce clock starts here. */
  updatedAt: string;
};

/** A dressed (video'd) finding with no TikTok post at all, oldest first. */
export type UnpostedInput = {
  addedAt: string;
  artUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
};

/** A recording, trimmed to the cues verdict (`hasVideo && no tracklist`). */
export type RecordingInput = {
  createdAt: string;
  hasVideo: boolean;
  id: string;
  /** Present ⇒ already promoted; its cues shipped with the mixtape. */
  mixtapeId?: string;
  title: string;
  tracklistLength: number;
};

/** A mixtape, trimmed to the distribution verdict (`status` + the two leg URLs). */
export type MixtapeInput = {
  anchorAt?: string;
  artUrl?: string;
  id: string;
  logId?: string;
  mixcloudUrl?: string;
  /** The promoted-from recording — the Studio deep-link target. */
  recordingId?: string;
  status: string;
  title: string;
  youtubeUrl?: string;
};

/** A clip drip row, trimmed to the queue-depth read. */
export type ClipPostInput = {
  scheduledFor: string;
  status: string;
};

/** An artist with unfinished follow work (candidates to confirm + followable-not-followed). */
export type ArtistReviewInput = {
  /** The oldest not-yet-actioned social's stamp — the queue's oldest-first anchor. */
  anchorAt: string;
  artistId: string;
  name: string;
  /** How many socials still need a look. */
  pending: number;
};

export type AttentionInputs = {
  artistReviews: ArtistReviewInput[];
  clipPosts: ClipPostInput[];
  drafts: DraftInput[];
  mixtapes: MixtapeInput[];
  recordings: RecordingInput[];
  unposted: UnpostedInput[];
};

/** When a pushed TikTok draft bounces: `updatedAt` + the shared 24h window. */
export function draftDeadline(updatedAt: string): string {
  return new Date(Date.parse(updatedAt) + TIKTOK_DRAFT_STALE_MS).toISOString();
}

/**
 * Map the five sources' raw rows into queue items. Pure and clock-injected; the
 * sources partition cleanly — a finding with ANY TikTok draft is a deadline row
 * (fresh: finish it; bounced: re-push it), never also the unposted row — so one
 * task is never two rows (the trust rule: a row the operator can't act on once
 * kills the queue).
 */
export function deriveAttentionItems(inputs: AttentionInputs, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Every pending TikTok inbox draft races the 24h bounce — the one true deadline.
  const drafted = new Set<string>();
  for (const draft of inputs.drafts) {
    drafted.add(draft.trackId);
    items.push({
      anchorAt: draft.updatedAt,
      ...(draft.artUrl ? { artUrl: draft.artUrl } : {}),
      deadlineAt: draftDeadline(draft.updatedAt),
      id: `tiktok-draft:${draft.trackId}`,
      ...(draft.logId ? { logId: draft.logId } : {}),
      source: "tiktok-draft",
      title: trackLabel(draft.artists, draft.title),
      trackId: draft.trackId,
    });
  }

  // The oldest dressed finding still off TikTok — ONE row (posting is serial:
  // TikTok caps pending drafts at 5/24h); the rest ride as its `waiting` datum
  // and surface one at a time as each clears. Defensive re-partition: a finding
  // already carrying a draft is that deadline row's business.
  const unposted = inputs.unposted.filter((track) => !drafted.has(track.trackId));
  const oldest = unposted[0];
  if (oldest) {
    items.push({
      anchorAt: oldest.addedAt,
      ...(oldest.artUrl ? { artUrl: oldest.artUrl } : {}),
      id: `post-tiktok:${oldest.trackId}`,
      ...(oldest.logId ? { logId: oldest.logId } : {}),
      source: "post-tiktok",
      title: trackLabel(oldest.artists, oldest.title),
      trackId: oldest.trackId,
      waiting: unposted.length,
    });
  }

  // A recorded take with no cue tracklist — nothing downstream (chapters, clips,
  // promote) works without cues. Derivation runs against Rekordbox on the M2.
  for (const recording of inputs.recordings) {
    if (!recording.hasVideo || recording.tracklistLength > 0 || recording.mixtapeId) {
      continue;
    }
    items.push({
      anchorAt: recording.createdAt,
      href: `/admin/studio/${encodeURIComponent(recording.id)}`,
      id: `attach-cues:${recording.id}`,
      machine: "M2",
      source: "attach-cues",
      title: recording.title,
    });
  }

  // A minted mixtape still mid-distribution — its missing legs (YouTube video,
  // Mixcloud audio) move multi-GB masters, so the action is M5-bound.
  for (const mixtape of inputs.mixtapes) {
    if (mixtape.status !== "distributing") {
      continue;
    }
    const missing: ("mixcloud" | "youtube")[] = [];
    if (!mixtape.youtubeUrl) {
      missing.push("youtube");
    }
    if (!mixtape.mixcloudUrl) {
      missing.push("mixcloud");
    }
    items.push({
      anchorAt: mixtape.anchorAt ?? new Date(now).toISOString(),
      ...(mixtape.artUrl ? { artUrl: mixtape.artUrl } : {}),
      href: mixtape.recordingId
        ? `/admin/studio/${encodeURIComponent(mixtape.recordingId)}`
        : "/admin/plans",
      id: `distribute:${mixtape.id}`,
      ...(mixtape.logId ? { logId: mixtape.logId } : {}),
      machine: "M5",
      missing,
      source: "distribute",
      title: mixtape.title,
    });
  }

  // The Instagram drip has nothing left to post — one singleton row, anchored to
  // the last slot that fired so it ages like everything else.
  const scheduled = inputs.clipPosts.filter((post) => post.status === "scheduled");
  if (scheduled.length === 0) {
    const lastSlot = inputs.clipPosts
      .map((post) => post.scheduledFor)
      .filter((slot) => !Number.isNaN(Date.parse(slot)))
      .sort()
      .at(-1);
    items.push({
      anchorAt: lastSlot ?? new Date(now).toISOString(),
      href: "/admin/clips",
      id: "drip-empty",
      source: "drip-empty",
      title: "Instagram drip",
    });
  }

  // Each artist with unfinished follow work is one row — the count is the datum, the
  // primary action deep-links to /admin/artists (the manage surface) with it focused.
  for (const review of inputs.artistReviews) {
    items.push({
      anchorAt: review.anchorAt,
      href: `/admin/artists?artist=${encodeURIComponent(review.artistId)}`,
      id: `artist-review:${review.artistId}`,
      reviewLinks: review.pending,
      source: "artist-review",
      title: review.name,
    });
  }

  return items;
}

// ─── Ordering + the working set ──────────────────────────────────────────────

/** The operator's per-row decisions, persisted client-side (one operator, one browser). */
export type QueuePrefs = {
  [id: string]: { snoozedUntil?: string; wontDoAt?: string } | undefined;
};

export type OrderedQueue = {
  /** Beyond the working set — still active, behind [Show all]. */
  backlog: AttentionItem[];
  /** Permanently dismissed ("Won't do") — restorable, never counted. */
  dismissed: AttentionItem[];
  /** The bounded working set — these count toward zero. */
  due: AttentionItem[];
  /** Snoozed until a time that hasn't passed yet. */
  snoozed: AttentionItem[];
};

/** The working-set bound: zero stays winnable, the rest is the backlog. */
export const WORKING_SET_SIZE = 7;

/**
 * Two-tier order + the operator's prefs: won't-do rows drop to `dismissed`,
 * unexpired snoozes to `snoozed` (an expired snooze re-enters on its own), then
 * deadline rows sort by time-to-deadline and everything else oldest-first. The
 * first `WORKING_SET_SIZE` are `due`; the rest are the backlog.
 */
export function orderQueue(items: AttentionItem[], prefs: QueuePrefs, now: number): OrderedQueue {
  const active: AttentionItem[] = [];
  const snoozed: AttentionItem[] = [];
  const dismissed: AttentionItem[] = [];

  for (const item of items) {
    const pref = prefs[item.id];
    if (pref?.wontDoAt) {
      dismissed.push(item);
    } else if (pref?.snoozedUntil && Date.parse(pref.snoozedUntil) > now) {
      snoozed.push(item);
    } else {
      active.push(item);
    }
  }

  const stamp = (iso: string) => {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? now : at;
  };

  active.sort((a, b) => {
    if (a.deadlineAt && b.deadlineAt) {
      return stamp(a.deadlineAt) - stamp(b.deadlineAt) || a.id.localeCompare(b.id);
    }
    if (a.deadlineAt !== b.deadlineAt && (a.deadlineAt || b.deadlineAt)) {
      return a.deadlineAt ? -1 : 1;
    }
    return stamp(a.anchorAt) - stamp(b.anchorAt) || a.id.localeCompare(b.id);
  });

  return {
    backlog: active.slice(WORKING_SET_SIZE),
    dismissed,
    due: active.slice(0, WORKING_SET_SIZE),
    snoozed,
  };
}

// ─── The instrument readouts (Oxanium tabular data, never prose) ─────────────

/** A duration as the panel's shortest honest unit: `17d`, `3h`, `12m`, `0m`. */
export function formatSpan(ms: number): string {
  const clamped = Math.max(0, ms);
  const days = Math.floor(clamped / 86_400_000);
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(clamped / 3_600_000);
  if (hours >= 1) {
    return `${hours}h`;
  }
  return `${Math.floor(clamped / 60_000)}m`;
}

/** A row's age readout off its oldest-first anchor. */
export function formatAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "0m" : formatSpan(now - at);
}

/** The deadline chip: counting down (`6h left`) or bounced (`bounced 3h`). */
export function deadlineReadout(
  deadlineAt: string,
  now: number,
): { label: string; overdue: boolean } {
  const at = Date.parse(deadlineAt);
  if (Number.isNaN(at)) {
    return { label: "0m left", overdue: false };
  }
  const remaining = at - now;
  return remaining > 0
    ? { label: `${formatSpan(remaining)} left`, overdue: false }
    : { label: `bounced ${formatSpan(-remaining)}`, overdue: true };
}

/** `9:00` / `13:05` — the one clock format the snooze slots and readout share. */
function clockLabel(at: Date): string {
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** A snoozed row's chip: the until-time as data (`until 9:00` / `until Mon 9:00`). */
export function snoozeReadout(untilIso: string, now: number): string {
  const at = Date.parse(untilIso);
  if (Number.isNaN(at)) {
    return "snoozed";
  }
  const until = new Date(at);
  const sameDay = new Date(now).toDateString() === until.toDateString();
  if (sameDay) {
    return `until ${clockLabel(until)}`;
  }
  const day = until.toLocaleDateString("en-US", { weekday: "short" });
  return `until ${day} ${clockLabel(until)}`;
}

// ─── Snooze slots ────────────────────────────────────────────────────────────

export type SnoozeSlot = { label: string; until: string };

/** 09:00 local on the given day. */
function atNine(base: Date): string {
  const at = new Date(base);
  at.setHours(9, 0, 0, 0);
  return at.toISOString();
}

/** The three plain snooze-until times: +3h, tomorrow 09:00, next Monday 09:00. */
export function snoozeSlots(now: number): SnoozeSlot[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const monday = new Date(now);
  // Next Monday, always in the future (today-is-Monday rolls a full week).
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));

  return [
    { label: "+3h", until: new Date(now + 3 * 3_600_000).toISOString() },
    { label: "Tomorrow 9:00", until: atNine(tomorrow) },
    { label: "Mon 9:00", until: atNine(monday) },
  ];
}

// ─── The primary action ──────────────────────────────────────────────────────

/**
 * What Enter fires on a row. Inline where an op exists (copy the caption for the
 * hand-finished TikTok post; re-push a bounced draft through the same gated op
 * the board's push dialog calls); a deep-link with the object selected everywhere
 * else (the Studio owns cues + distribution, the clip library owns the drip).
 */
export type PrimaryAction =
  | { kind: "copy-caption"; label: "Copy caption" }
  | { href: string; kind: "open"; label: string }
  | { kind: "re-push"; label: "Re-push draft" };

export function primaryFor(item: AttentionItem, now: number): PrimaryAction {
  switch (item.source) {
    case "artist-review":
      return { href: item.href ?? "/admin/artists", kind: "open", label: "Review" };
    case "attach-cues":
      return { href: item.href ?? "/admin/plans", kind: "open", label: "Attach cues" };
    case "distribute":
      return { href: item.href ?? "/admin/plans", kind: "open", label: "Distribute" };
    case "drip-empty":
      return { href: item.href ?? "/admin/clips", kind: "open", label: "Cut clips" };
    case "post-tiktok":
      return { kind: "copy-caption", label: "Copy caption" };
    case "tiktok-draft": {
      const bounced = item.deadlineAt !== undefined && Date.parse(item.deadlineAt) <= now;
      // "Re-push draft" — the board push dialog's exact sibling label.
      return bounced
        ? { kind: "re-push", label: "Re-push draft" }
        : { kind: "copy-caption", label: "Copy caption" };
    }
  }
}
