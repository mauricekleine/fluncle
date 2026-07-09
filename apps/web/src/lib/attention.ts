// The attention queue's pure model. Every decision the `/admin` home makes — which
// rows exist, which tier they ride, what order they land in, what the working set
// is, what a deadline reads as — lives here as plain functions over plain data with
// an injected clock, so the queue's mechanics are provable without a database or a
// browser (the track-stage.ts precedent). The server (lib/server/attention.ts) feeds `derive*` real
// rows; the route feeds `orderQueue` the operator's snooze/won't-do prefs.
//
// The two-tier ordering is ratified: DEADLINE rows (a TikTok inbox draft racing
// its 24h bounce) sort by time-to-deadline, everything else oldest-first. The
// bounded working set keeps zero winnable: the top rows count toward zero, the
// rest age into a backlog behind [Show all].

import { TIKTOK_DRAFT_STALE_MS, trackLabel } from "@fluncle/contracts/util";
import { type AttentionRow, type AttentionSourceCount } from "@fluncle/contracts";

// ─── The rows ────────────────────────────────────────────────────────────────

/** The queue sources (the roadmap's data-honesty-verified EXISTS set). */
export type AttentionSource =
  | "artist-review"
  | "attach-cues"
  | "distribute"
  | "drip-empty"
  | "post-tiktok"
  | "post-youtube"
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
  /** The machine an action is bound to (the machine model). */
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

/** A finding's post status on one platform (absent ⇒ never pushed). */
export type SocialStatus = "draft" | "scheduled" | "published" | "failed";

/**
 * A dressed (video'd) finding with a pending distribution leg, joined to its per-platform
 * post state. The two platforms post differently, so each is its own todo: TikTok goes
 * none → draft (a silent inbox draft you finish in-app) → published; YouTube posts a public
 * Short the moment you push (none → published).
 */
export type ClipInput = {
  addedAt: string;
  artUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
  tiktokStatus?: SocialStatus;
  /** The TikTok draft's push time — the 24h bounce clock (set when tiktokStatus is "draft"). */
  tiktokUpdatedAt?: string;
  youtubeStatus?: SocialStatus;
};

/** A distribution leg is settled once it's live (published) or scheduled to go. */
function isPosted(status?: SocialStatus): boolean {
  return status === "published" || status === "scheduled";
}

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

/** An artist with unfinished review work (links discovered since the last "Looks good"). */
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
  clips: ClipInput[];
  mixtapes: MixtapeInput[];
  recordings: RecordingInput[];
};

/** When a pushed TikTok draft bounces: `updatedAt` + the shared 24h window. */
export function draftDeadline(updatedAt: string): string {
  return new Date(Date.parse(updatedAt) + TIKTOK_DRAFT_STALE_MS).toISOString();
}

/**
 * Map the sources' raw rows into queue items. Pure and clock-injected. A clip's two
 * distribution legs (TikTok, YouTube) are SEPARATE todos — each posts differently — so a
 * clip yields up to two rows, but only the oldest clip with a pending leg surfaces them:
 * the next clip appears once both of this one's legs land. Independent of that gate, every
 * TikTok inbox draft is a deadline row racing its 24h bounce (finish it / re-push it), so an
 * in-flight draft is never hidden behind the one-clip-at-a-time queue.
 */
export function deriveAttentionItems(inputs: AttentionInputs, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Every pending TikTok inbox draft races the 24h bounce — the one true deadline. ALL are
  // shown (urgency), regardless of the one-clip-at-a-time gate on fresh pushes below.
  for (const clip of inputs.clips) {
    if (clip.tiktokStatus !== "draft" || !clip.tiktokUpdatedAt) {
      continue;
    }
    items.push({
      anchorAt: clip.tiktokUpdatedAt,
      ...(clip.artUrl ? { artUrl: clip.artUrl } : {}),
      deadlineAt: draftDeadline(clip.tiktokUpdatedAt),
      id: `tiktok-draft:${clip.trackId}`,
      ...(clip.logId ? { logId: clip.logId } : {}),
      source: "tiktok-draft",
      title: trackLabel(clip.artists, clip.title),
      trackId: clip.trackId,
    });
  }

  // The oldest clip with a pending leg is the focus — its pending platforms surface as
  // separate todos, and the next clip appears only once BOTH of these land. The rest ride as
  // the `waiting` datum. (TikTok caps pending inbox drafts at 5/24h, so posting stays serial.)
  const pending = inputs.clips.filter(
    (clip) => !isPosted(clip.tiktokStatus) || !isPosted(clip.youtubeStatus),
  );
  const focus = pending[0];
  if (focus) {
    // The TikTok leg — a FRESH push (no post yet, or a prior failed one). A draft is already
    // the deadline row above, so it is not re-emitted here.
    if (!isPosted(focus.tiktokStatus) && focus.tiktokStatus !== "draft") {
      items.push({
        anchorAt: focus.addedAt,
        ...(focus.artUrl ? { artUrl: focus.artUrl } : {}),
        id: `post-tiktok:${focus.trackId}`,
        ...(focus.logId ? { logId: focus.logId } : {}),
        source: "post-tiktok",
        title: trackLabel(focus.artists, focus.title),
        trackId: focus.trackId,
        waiting: pending.length,
      });
    }
    // The YouTube leg — a public Short posts the moment you push, so it's a one-tap todo.
    if (!isPosted(focus.youtubeStatus)) {
      items.push({
        anchorAt: focus.addedAt,
        ...(focus.artUrl ? { artUrl: focus.artUrl } : {}),
        id: `post-youtube:${focus.trackId}`,
        ...(focus.logId ? { logId: focus.logId } : {}),
        source: "post-youtube",
        title: trackLabel(focus.artists, focus.title),
        trackId: focus.trackId,
        waiting: pending.length,
      });
    }
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

  // Each artist with unfinished review work is one row — the count is the datum, the
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
 * What Enter fires on a row. Inline where an op exists: push a platform's video (a fresh
 * TikTok inbox draft or the public YouTube Short), copy the caption for a TikTok draft you're
 * finishing in-app, or re-push a bounced draft — all the same gated ops the board push dialog
 * calls. A deep-link with the object selected everywhere else (the Studio owns cues +
 * distribution, the clip library owns the drip).
 */
export type PrimaryAction =
  | { kind: "copy-caption"; label: "Copy caption" }
  | { href: string; kind: "open"; label: string }
  | { kind: "push"; label: string; platform: "tiktok" | "youtube" }
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
      // No TikTok post yet — the first step is pushing the silent inbox draft.
      return { kind: "push", label: "Push draft", platform: "tiktok" };
    case "post-youtube":
      return { kind: "push", label: "Post to YouTube", platform: "youtube" };
    case "tiktok-draft": {
      const bounced = item.deadlineAt !== undefined && Date.parse(item.deadlineAt) <= now;
      // A pushed draft is finished in-app: copy the caption to paste there; re-push if bounced.
      return bounced
        ? { kind: "re-push", label: "Re-push draft" }
        : { kind: "copy-caption", label: "Copy caption" };
    }
  }
}

// ─── The menu-bar digest (the operator's CLI + Raycast read) ─────────────────
// The same snapshot the `/admin` dashboard renders, folded into a portable digest
// so the operator's own tools (`fluncle admin queue`, its Raycast menu-bar sibling)
// read it without a browser. Pure and clock-injected, like the rest of this model.

/** The priority order the digest counts + the brief walk (deadline/urgent first). */
const SOURCE_ORDER: AttentionSource[] = [
  "tiktok-draft",
  "post-tiktok",
  "post-youtube",
  "distribute",
  "attach-cues",
  "drip-empty",
  "artist-review",
];

/**
 * Where clicking a row lands the operator. Rows that carry an explicit `href`
 * (attach-cues, distribute, drip-empty, artist-review) open it; the inline
 * publish-loop rows (post-tiktok, post-youtube, tiktok-draft) have no href — their
 * action lives on the dashboard itself, so they open `/admin`.
 */
export function attentionRowPath(item: AttentionItem): string {
  return item.href ?? "/admin";
}

/** An `AttentionItem` reduced to its wire row (the deep-link path + the meta the menu bar shows). */
function toAttentionRow(item: AttentionItem): AttentionRow {
  return {
    ...(item.deadlineAt ? { deadlineAt: item.deadlineAt } : {}),
    ...(item.logId ? { logId: item.logId } : {}),
    path: attentionRowPath(item),
    source: item.source,
    title: item.title,
    ...(item.waiting !== undefined ? { waiting: item.waiting } : {}),
  };
}

/** English 2–9 as words (the dispatch's small-count voice: "two drafts to finish"). */
const SMALL_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/** A count as the dispatch spells it: 2–9 as a word, everything else as digits. */
function countWord(n: number): string {
  return n >= 2 && n <= 9 ? (SMALL_WORDS[n] ?? String(n)) : String(n);
}

/** One source's phrase in the dispatch, from its waiting rows. */
function briefPhrase(source: AttentionSource, rows: AttentionItem[]): string {
  const n = rows.length;

  switch (source) {
    case "artist-review":
      return n === 1 ? "an artist's links to review" : `${countWord(n)} artists' links to review`;
    case "attach-cues":
      return n === 1 ? "a recording waiting on cues" : `${countWord(n)} recordings waiting on cues`;
    case "distribute": {
      if (n !== 1) {
        return `${countWord(n)} mixtapes to distribute`;
      }
      // One mixtape: name the missing leg when it's the only one left ("waiting on Mixcloud").
      const missing = rows[0]?.missing ?? [];
      if (missing.length === 1 && missing[0] === "mixcloud") {
        return "a mixtape waiting on Mixcloud";
      }
      if (missing.length === 1 && missing[0] === "youtube") {
        return "a mixtape waiting on YouTube";
      }
      return "a mixtape to distribute";
    }
    case "drip-empty":
      return "the Instagram drip's run dry";
    case "post-tiktok":
      return n === 1 ? "a clip to push to TikTok" : `${countWord(n)} clips to push to TikTok`;
    case "post-youtube":
      return n === 1 ? "a clip to post to YouTube" : `${countWord(n)} clips to post to YouTube`;
    case "tiktok-draft":
      return n === 1 ? "a TikTok draft to finish" : `${countWord(n)} TikTok drafts to finish`;
  }
}

/**
 * The deterministic, Fluncle-voiced morning dispatch — one plain, deadpan line
 * assembled from the counts (never an LLM). Per-source phrases in priority order,
 * comma-joined; a clear board reads as a quiet all-clear. Operator-plain per the
 * admin persona register (functional, warm-by-brevity, no exclamation, no em dash).
 */
export function attentionBrief(items: AttentionItem[], _now: number): string {
  const phrases: string[] = [];

  for (const source of SOURCE_ORDER) {
    const rows = items.filter((item) => item.source === source);
    if (rows.length > 0) {
      phrases.push(briefPhrase(source, rows));
    }
  }

  if (phrases.length === 0) {
    return "All clear. Quiet sector.";
  }

  const joined = phrases.join(", ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/** The whole digest: the total, per-source counts, ordered rows, and the dispatch. */
export function deriveAttentionDigest(
  items: AttentionItem[],
  now: number,
): { brief: string; counts: AttentionSourceCount[]; rows: AttentionRow[]; total: number } {
  // Order the rows the ratified way (deadline-first, then oldest) with no operator
  // prefs — the digest carries the raw truth; snooze/won't-do is client-only.
  const ordered = orderQueue(items, {}, now);
  const rows = [...ordered.due, ...ordered.backlog].map(toAttentionRow);

  const counts: AttentionSourceCount[] = [];
  for (const source of SOURCE_ORDER) {
    const count = items.filter((item) => item.source === source).length;
    if (count > 0) {
      counts.push({ count, source });
    }
  }

  return { brief: attentionBrief(items, now), counts, rows, total: items.length };
}
