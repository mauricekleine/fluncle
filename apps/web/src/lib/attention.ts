import { TIKTOK_DRAFT_STALE_MS, trackLabel } from "@fluncle/contracts/util";
import {
  type AttentionRow,
  type AttentionSource,
  type AttentionSourceCount,
} from "@fluncle/contracts";

export type { AttentionSource };

export type AttentionCandidate = {
  artists: string[];
  deltaMs: number;
  descriptor: string;
  spotifyTrackId?: string;
  title: string;
};

export type AttentionItem = {
  anchorAt: string;

  artUrl?: string;

  attempts?: number;

  candidate?: AttentionCandidate;

  deadlineAt?: string;

  entity?: { kind: "album" | "artist" | "label"; slug: string };

  href?: string;

  id: string;
  logId?: string;

  machine?: "M2" | "M5";

  mbUrl?: string;

  missing?: ("mixcloud" | "youtube")[];

  reviewLinks?: number;
  source: AttentionSource;
  title: string;
  trackId?: string;

  verdict?: string;

  violations?: string[];

  waiting?: number;
};

export type SocialStatus = "draft" | "scheduled" | "published" | "failed";

export type ClipInput = {
  addedAt: string;
  artUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
  tiktokStatus?: SocialStatus;

  tiktokUpdatedAt?: string;
  youtubeStatus?: SocialStatus;
};

function isPosted(status?: SocialStatus): boolean {
  return status === "published" || status === "scheduled";
}

export type RecordingInput = {
  createdAt: string;
  hasVideo: boolean;
  id: string;

  mixtapeId?: string;
  title: string;
  tracklistLength: number;
};

export type MixtapeInput = {
  anchorAt?: string;
  artUrl?: string;
  id: string;
  logId?: string;
  mixcloudUrl?: string;

  recordingId?: string;
  status: string;
  title: string;
  youtubeUrl?: string;
};

export type ClipPostInput = {
  scheduledFor: string;
  status: string;
};

export type ArtistReviewInput = {
  anchorAt: string;
  artistId: string;
  name: string;

  pending: number;
};

export type LabelReviewInput = {
  anchorAt: string;
  labelId: string;
  name: string;
};

export type BioReviewInput = {
  anchorAt: string;
  kind: "album" | "artist" | "label";
  name: string;
  slug: string;

  violations: string[];
};

export type AnchorReviewInput = {
  anchorAt: string;
  artUrl?: string;
  artists: string[];
  candidateArtists: string[];
  candidateDescriptor: string;

  candidateSpotifyTrackId?: string;
  candidateTitle: string;

  deltaMs: number;

  mbRecordingId?: string;
  title: string;
  trackId: string;
};

export type AnchorFailureInput = {
  anchorAt: string;
  artists: string[];
  error: string;
  mbRecordingId?: string;
  title: string;
  trackId: string;
};

export type SubmissionInput = {
  artUrl?: string;
  artists: string[];

  createdAt: string;

  id: string;
  title: string;

  triageVerdict?: string;
};

export type NoteRejectionInput = {
  anchorAt: string;
  artUrl?: string;
  artists: string[];

  attempts: number;

  id: string;
  title: string;

  trackId: string;
};

export type ObservationRejectionInput = {
  anchorAt: string;
  artUrl?: string;
  artists: string[];

  attempts: number;

  id: string;
  logId?: string;
  title: string;

  trackId: string;
};

export type CaptureSuspectInput = {
  artUrl?: string;
  artists: string[];

  anchorAt: string;
  logId?: string;
  title: string;

  trackId: string;
};

export type NewsletterInput = {
  draftedAt: string;

  id: string;

  subject?: string;
};

export type AttentionInputs = {
  anchorFailures?: AnchorFailureInput[];
  anchorReviews: AnchorReviewInput[];
  artistReviews: ArtistReviewInput[];
  bioReviews: BioReviewInput[];
  captureSuspects: CaptureSuspectInput[];
  clipPosts: ClipPostInput[];
  clips: ClipInput[];
  labelReviews: LabelReviewInput[];
  mixtapes: MixtapeInput[];
  newsletters: NewsletterInput[];
  noteRejections: NoteRejectionInput[];
  observationRejections: ObservationRejectionInput[];
  recordings: RecordingInput[];
  submissions: SubmissionInput[];
};

export function draftDeadline(updatedAt: string): string {
  return new Date(Date.parse(updatedAt) + TIKTOK_DRAFT_STALE_MS).toISOString();
}

export function newsletterDeadline(draftedAt: string): string {
  return new Date(Date.parse(draftedAt) + 24 * 60 * 60 * 1000).toISOString();
}

function appendClipAttentionItems(items: AttentionItem[], clips: ClipInput[]): void {
  for (const clip of clips) {
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
  const pending = clips.filter(
    (clip) => !isPosted(clip.tiktokStatus) || !isPosted(clip.youtubeStatus),
  );
  const focus = pending[0];
  if (!focus) {
    return;
  }
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

function appendRecordingAttentionItems(
  items: AttentionItem[],
  recordings: AttentionInputs["recordings"],
): void {
  for (const recording of recordings) {
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
}

function appendMixtapeAttentionItems(
  items: AttentionItem[],
  mixtapes: AttentionInputs["mixtapes"],
  now: number,
): void {
  for (const mixtape of mixtapes) {
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
}

export function deriveAttentionItems(inputs: AttentionInputs, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const failure of inputs.anchorFailures ?? []) {
    items.push({
      anchorAt: failure.anchorAt,
      href: failure.mbRecordingId
        ? `https://musicbrainz.org/recording/${failure.mbRecordingId.replace(/^mb_/, "")}`
        : "/admin/catalogue",
      id: `anchor-failure:${failure.trackId}`,
      source: "anchor-failure",
      title: `${trackLabel(failure.artists, failure.title)} · ${failure.error}`,
      trackId: failure.trackId,
    });
  }

  appendClipAttentionItems(items, inputs.clips);

  appendRecordingAttentionItems(items, inputs.recordings);

  appendMixtapeAttentionItems(items, inputs.mixtapes, now);

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

  for (const review of inputs.labelReviews) {
    items.push({
      anchorAt: review.anchorAt,
      href: "/admin/labels",
      id: `label-review:${review.labelId}`,
      source: "label-review",
      title: review.name,
    });
  }

  for (const review of inputs.bioReviews) {
    items.push({
      anchorAt: review.anchorAt,
      entity: { kind: review.kind, slug: review.slug },
      id: `bio-review:${review.kind}:${review.slug}`,
      source: "bio-review",
      title: review.name,
      violations: review.violations,
    });
  }

  for (const review of inputs.anchorReviews) {
    items.push({
      anchorAt: review.anchorAt,
      ...(review.artUrl ? { artUrl: review.artUrl } : {}),
      candidate: {
        artists: review.candidateArtists,
        deltaMs: review.deltaMs,
        descriptor: review.candidateDescriptor,
        ...(review.candidateSpotifyTrackId
          ? { spotifyTrackId: review.candidateSpotifyTrackId }
          : {}),
        title: review.candidateTitle,
      },
      id: `anchor-review:${review.trackId}`,
      ...(review.mbRecordingId
        ? { mbUrl: `https://musicbrainz.org/recording/${review.mbRecordingId}` }
        : {}),
      source: "anchor-review",
      title: trackLabel(review.artists, review.title),
      trackId: review.trackId,
    });
  }

  for (const suspect of inputs.captureSuspects) {
    items.push({
      anchorAt: suspect.anchorAt,
      ...(suspect.artUrl ? { artUrl: suspect.artUrl } : {}),
      href: "/admin/catalogue?lens=quarantine",
      id: `capture-suspect:${suspect.trackId}`,
      ...(suspect.logId ? { logId: suspect.logId } : {}),
      source: "capture-suspect",
      title: trackLabel(suspect.artists, suspect.title),
      trackId: suspect.trackId,
    });
  }

  for (const newsletter of inputs.newsletters) {
    items.push({
      anchorAt: newsletter.draftedAt,

      deadlineAt: newsletterDeadline(newsletter.draftedAt),
      href: "/admin/newsletter",
      id: `newsletter:${newsletter.id}`,
      source: "newsletter",
      title: newsletter.subject ?? "Draft edition",
    });
  }

  for (const rejection of inputs.noteRejections) {
    items.push({
      anchorAt: rejection.anchorAt,
      ...(rejection.artUrl ? { artUrl: rejection.artUrl } : {}),
      attempts: rejection.attempts,
      href: `/admin/findings?note=${encodeURIComponent(rejection.trackId)}`,
      id: `note-rejected:${rejection.id}`,
      source: "note-rejected",
      title: trackLabel(rejection.artists, rejection.title),
      trackId: rejection.trackId,
    });
  }

  for (const rejection of inputs.observationRejections) {
    items.push({
      anchorAt: rejection.anchorAt,
      ...(rejection.artUrl ? { artUrl: rejection.artUrl } : {}),
      attempts: rejection.attempts,
      href: `/admin/findings?observation=${encodeURIComponent(rejection.trackId)}`,
      id: `observation-rejected:${rejection.id}`,
      ...(rejection.logId ? { logId: rejection.logId } : {}),
      source: "observation-rejected",
      title: trackLabel(rejection.artists, rejection.title),
      trackId: rejection.trackId,
    });
  }

  for (const submission of inputs.submissions) {
    items.push({
      anchorAt: submission.createdAt,
      ...(submission.artUrl ? { artUrl: submission.artUrl } : {}),
      href: `/admin/findings?submission=${encodeURIComponent(submission.id)}`,
      id: `submission:${submission.id}`,
      source: "submission",
      title: trackLabel(submission.artists, submission.title),
      ...(submission.triageVerdict ? { verdict: submission.triageVerdict } : {}),
    });
  }

  return items;
}

export type QueuePrefs = {
  [id: string]: { snoozedUntil?: string; wontDoAt?: string } | undefined;
};

export type OrderedQueue = {
  backlog: AttentionItem[];

  dismissed: AttentionItem[];

  due: AttentionItem[];

  snoozed: AttentionItem[];
};

export const WORKING_SET_SIZE = 7;

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

export function formatDelta(ms: number): string {
  const seconds = ms / 1000;
  const rounded = Math.abs(seconds) < 0.05 ? 0 : seconds;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";

  return `${sign}${Math.abs(rounded).toFixed(1)}s`;
}

export function formatAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "0m" : formatSpan(now - at);
}

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

function clockLabel(at: Date): string {
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

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

export type SnoozeSlot = { label: string; until: string };

function atNine(base: Date): string {
  const at = new Date(base);
  at.setHours(9, 0, 0, 0);
  return at.toISOString();
}

export function snoozeSlots(now: number): SnoozeSlot[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const monday = new Date(now);

  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));

  return [
    { label: "+3h", until: new Date(now + 3 * 3_600_000).toISOString() },
    { label: "Tomorrow 9:00", until: atNine(tomorrow) },
    { label: "Mon 9:00", until: atNine(monday) },
  ];
}

export type PrimaryAction =
  | { kind: "accept-anchor"; label: "Use this match" }
  | { kind: "copy-caption"; label: "Copy caption" }
  | { kind: "keep-bio"; label: "Bio stands" }
  | { href: string; kind: "open"; label: string }
  | { kind: "push"; label: string; platform: "tiktok" | "youtube" }
  | { kind: "re-push"; label: "Re-push draft" };

export function primaryFor(item: AttentionItem, now: number): PrimaryAction {
  switch (item.source) {
    case "anchor-review":
      return item.candidate?.spotifyTrackId
        ? { kind: "accept-anchor", label: "Use this match" }
        : { href: item.mbUrl ?? "/admin/catalogue", kind: "open", label: "Open in MusicBrainz" };
    case "anchor-failure":
      return { href: item.href ?? "/admin/catalogue", kind: "open", label: "Inspect row" };
    case "artist-review":
      return { href: item.href ?? "/admin/artists", kind: "open", label: "Review" };
    case "attach-cues":
      return { href: item.href ?? "/admin/plans", kind: "open", label: "Attach cues" };
    case "bio-review":
      return { kind: "keep-bio", label: "Bio stands" };
    case "capture-suspect":
      return { href: item.href ?? "/admin/catalogue", kind: "open", label: "Check it" };
    case "distribute":
      return { href: item.href ?? "/admin/plans", kind: "open", label: "Distribute" };
    case "drip-empty":
      return { href: item.href ?? "/admin/clips", kind: "open", label: "Cut clips" };
    case "label-review":
      return { href: item.href ?? "/admin/labels", kind: "open", label: "Rule on it" };
    case "newsletter":
      return { href: item.href ?? "/admin/newsletter", kind: "open", label: "Review" };
    case "note-rejected":
      return { href: item.href ?? "/admin/findings", kind: "open", label: "Read it" };
    case "observation-rejected":
      return { href: item.href ?? "/admin/findings", kind: "open", label: "Hear it" };
    case "post-tiktok":
      return { kind: "push", label: "Push draft", platform: "tiktok" };
    case "post-youtube":
      return { kind: "push", label: "Post to YouTube", platform: "youtube" };
    case "submission":
      return { href: item.href ?? "/admin/findings?submission=", kind: "open", label: "Review" };
    case "tiktok-draft": {
      const bounced = item.deadlineAt !== undefined && Date.parse(item.deadlineAt) <= now;

      return bounced
        ? { kind: "re-push", label: "Re-push draft" }
        : { kind: "copy-caption", label: "Copy caption" };
    }
  }
}

const SOURCE_ORDER: AttentionSource[] = [
  "anchor-failure",
  "tiktok-draft",
  "post-tiktok",
  "post-youtube",
  "distribute",
  "attach-cues",
  "drip-empty",
  "newsletter",
  "submission",
  "artist-review",

  "label-review",

  "capture-suspect",

  "anchor-review",

  "bio-review",

  "note-rejected",

  "observation-rejected",
];

export function attentionRowPath(item: AttentionItem): string {
  return item.href ?? "/admin";
}

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

function countWord(n: number): string {
  return n >= 2 && n <= 9 ? (SMALL_WORDS[n] ?? String(n)) : String(n);
}

function briefPhrase(source: AttentionSource, rows: AttentionItem[]): string {
  const n = rows.length;

  switch (source) {
    case "anchor-failure":
      return n === 1
        ? "an anchor request held for review"
        : `${countWord(n)} anchor requests held for review`;
    case "anchor-review":
      return n === 1
        ? "a track that may be the wrong version"
        : `${countWord(n)} tracks that may be the wrong version`;
    case "artist-review":
      return n === 1 ? "an artist's links to review" : `${countWord(n)} artists' links to review`;
    case "attach-cues":
      return n === 1 ? "a recording waiting on cues" : `${countWord(n)} recordings waiting on cues`;
    case "bio-review":
      return n === 1
        ? "a bio that landed past the voice gate"
        : `${countWord(n)} bios that landed past the voice gate`;
    case "capture-suspect":
      return n === 1
        ? "a capture that doesn't sound right"
        : `${countWord(n)} captures that don't sound right`;
    case "distribute": {
      if (n !== 1) {
        return `${countWord(n)} mixtapes to distribute`;
      }

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
    case "label-review":
      return n === 1 ? "a new label to rule on" : `${countWord(n)} new labels to rule on`;
    case "newsletter":
      return n === 1
        ? "the Friday letter waiting on your send"
        : `${countWord(n)} letters waiting on your send`;
    case "note-rejected":
      return n === 1
        ? "a note the echo gate held back"
        : `${countWord(n)} notes the echo gate held back`;
    case "observation-rejected":
      return n === 1
        ? "an observation the echo gate held back"
        : `${countWord(n)} observations the echo gate held back`;
    case "post-tiktok":
      return n === 1 ? "a clip to push to TikTok" : `${countWord(n)} clips to push to TikTok`;
    case "post-youtube":
      return n === 1 ? "a clip to post to YouTube" : `${countWord(n)} clips to post to YouTube`;
    case "submission":
      return n === 1 ? "a crew submission to hear" : `${countWord(n)} crew submissions to hear`;
    case "tiktok-draft":
      return n === 1 ? "a TikTok draft to finish" : `${countWord(n)} TikTok drafts to finish`;
  }
}

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

export function deriveAttentionDigest(
  items: AttentionItem[],
  now: number,
): { brief: string; counts: AttentionSourceCount[]; rows: AttentionRow[]; total: number } {
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
