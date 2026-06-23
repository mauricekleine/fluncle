import {
  CassetteTapeIcon,
  CrosshairIcon,
  FileTextIcon,
  FilmSlateIcon,
  HeartIcon,
  type IconWeight,
  MicrophoneIcon,
  NotePencilIcon,
  VinylRecordIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { type ComponentType } from "react";
import { TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
import { GALAXIES, galaxyForVibe } from "@/lib/galaxies";
import { type BlockedOn, type Stage } from "@/lib/server/track-stage";
import { type BoardRow } from "@/components/admin/use-publish";

/** A step glyph — a phosphor icon or a wrapped simple-icons brand mark, same call. */
export type StepIcon = ComponentType<{ className?: string; weight?: IconWeight }>;

// ─────────────────────────────────────────────────────────────────────────────
// The shared step model for the board's variant explorer.
//
// The board's real problem: a finding moves through ~a dozen steps that are NOT a
// strict chain — some run on agents (enrich, context, observation, video, discogs),
// some are the operator's own hands (tag, note, the two pushes, a mixtape, a
// Last.fm love), they fire in parallel, they fail and retry, and the order drifts.
// Every variant answers the same question — "roughly where is this finding?" — so
// they all read from ONE derivation here. Add a step once, in STEP_DEFS, and every
// variant renders it.
//
// State is carried by SHAPE first (DESIGN: gold ≤10%), so the board stays legible
// without painting a dozen gold cells per row:
//   kind   — `auto` (an agent does it) reads round; `human` (your hands) reads square.
//   state  — open → running → partial → done, plus `planned` for a step that's
//            designed-in but not wired yet, shown ghosted so a variant's density
//            reflects where the pipeline is heading, not just where it is.
// ─────────────────────────────────────────────────────────────────────────────

export type StepKey =
  | "enrich"
  | "discogs"
  | "tag"
  | "video"
  | "context"
  | "observation"
  | "note"
  | "youtube"
  | "tiktok"
  | "mixtape"
  | "lastfm";

/** Who advances the step: an agent (`auto`) or the operator (`human`). */
export type StepKind = "auto" | "human";

/**
 * open    — nothing yet; for a human step this is your move (when not gated).
 * running — an agent step in flight (enrichment processing).
 * partial — touched, not closed (a pushed-but-not-live draft; context gathered but
 *           not voiced; a finding sitting in a draft tape).
 * done    — closed.
 * planned — designed-in, not wired yet; ghosted, never actionable.
 */
export type StepState = "open" | "running" | "partial" | "done" | "planned";

/** The callbacks the board hands every variant — one per openable step dialog. */
export type BoardActions = {
  onEnrich: (row: BoardRow) => void;
  onTag: (row: BoardRow) => void;
  onContext: (row: BoardRow) => void;
  onObservation: (row: BoardRow) => void;
  onNote: (row: BoardRow) => void;
  onPush: (row: BoardRow, platformKey: "youtube" | "tiktok") => void;
  onMixtape: (row: BoardRow) => void;
  onPreview: (row: BoardRow) => void;
};

export type BoardStep = {
  key: StepKey;
  kind: StepKind;
  /** Full label for legends + tooltips ("Observation"). */
  label: string;
  /** The resting state of the step for this finding. */
  state: StepState;
  /** A one-glance status word ("Heard", "Drafted", "Live") for verbose variants. */
  statusLabel: string;
  /** The icon glyph. */
  Icon: StepIcon;
  /** A short tooltip / aria description. */
  hint: string;
  /** Whether a click does anything for this finding right now. */
  actionable: boolean;
  /** Gated: the prerequisite (a video) isn't there yet, so it's not your move. */
  gated: boolean;
};

/** A finding plus its derived lifecycle position and full step list. */
export type BoardEntry = {
  row: BoardRow;
  stage: Stage;
  blockedOn: BlockedOn;
  steps: BoardStep[];
};

/** What the pipeline board renders from — the live findings + the action callbacks. */
export type BoardProps = {
  entries: BoardEntry[];
  actions: BoardActions;
};

// The canonical order + identity of every step. Lifecycle-ish (rough, not fixed),
// agents first then your hands, in the order each group's work tends to land. The
// Last.fm love is automated (an agent loves the track once it's added), so it sits
// among the agents, right after the enrichment it rides along with.
const STEP_DEFS: { key: StepKey; kind: StepKind; label: string; Icon: StepIcon }[] = [
  { Icon: WaveformIcon, key: "enrich", kind: "auto", label: "Enrich" },
  { Icon: HeartIcon, key: "lastfm", kind: "auto", label: "Last.fm" },
  { Icon: VinylRecordIcon, key: "discogs", kind: "auto", label: "Discogs" },
  { Icon: FilmSlateIcon, key: "video", kind: "auto", label: "Video" },
  { Icon: FileTextIcon, key: "context", kind: "auto", label: "Context" },
  { Icon: MicrophoneIcon, key: "observation", kind: "auto", label: "Observation" },
  { Icon: CrosshairIcon, key: "tag", kind: "human", label: "Tag" },
  { Icon: NotePencilIcon, key: "note", kind: "human", label: "Note" },
  { Icon: YoutubeIcon, key: "youtube", kind: "human", label: "YouTube" },
  { Icon: TiktokIcon, key: "tiktok", kind: "human", label: "TikTok" },
  { Icon: CassetteTapeIcon, key: "mixtape", kind: "human", label: "Mixtape" },
];

function publishStep(
  row: BoardRow,
  platform: "youtube" | "tiktok",
): Pick<BoardStep, "state" | "statusLabel" | "hint" | "actionable" | "gated"> {
  const post = row.posts.find((entry) => entry.platform === platform);
  const status = post?.status;
  const hasLiveUrl = Boolean(post?.url);
  // Live only closes the circuit once a public URL is recorded; YouTube auto-posts
  // and TikTok is finished in-app, so both land "published" with the link missing —
  // a partial, not done. A failed push re-opens it as a retry.
  const state: StepState =
    status === "published"
      ? hasLiveUrl
        ? "done"
        : "partial"
      : status === "draft" || status === "scheduled"
        ? "partial"
        : "open";
  const statusLabel =
    status === "published"
      ? hasLiveUrl
        ? "Live"
        : "Add link"
      : status === "scheduled"
        ? "Scheduled"
        : status === "draft"
          ? "Drafted"
          : status === "failed"
            ? "Retry"
            : "Push";
  // Nothing to push until there's a video — unless a post already exists.
  const gated = !row.videoUrl && !post;
  const label = platform === "youtube" ? "YouTube" : "TikTok";

  return {
    actionable: !gated,
    gated,
    hint: gated ? "No video yet — render first" : `${label} publish`,
    state,
    statusLabel,
  };
}

/**
 * Derive every step for one finding. Pure — reads the row's own fields plus its
 * social posts and mixtape memberships, exactly like the live board's cells, so the
 * variants never drift from the real state.
 */
export function boardSteps(row: BoardRow): BoardStep[] {
  const tagged = row.vibeX !== undefined && row.vibeY !== undefined;
  const galaxy =
    row.galaxy?.key ??
    (row.vibeX !== undefined && row.vibeY !== undefined
      ? galaxyForVibe(row.vibeX, row.vibeY)
      : undefined);
  const note = row.note?.trim();
  const rendered = Boolean(row.observationAudioUrl);
  const onTape = row.mixtapes.some((m) => m.status === "published" || m.status === "distributing");
  const inDraftTape = !onTape && row.mixtapes.length > 0;

  const partials: Record<
    StepKey,
    Pick<BoardStep, "state" | "statusLabel" | "hint" | "actionable" | "gated">
  > = {
    context: {
      actionable: true,
      gated: false,
      hint: row.hasContextNote ? "View the context note" : "No context gathered yet",
      state: row.hasContextNote ? "done" : "open",
      statusLabel: row.hasContextNote ? "Context" : "No context",
    },
    discogs: {
      // The board is a WORKFLOW tracker, not a data-existence tracker. The Discogs
      // backfill ran-but-found-no-release is a SUCCESS (the workflow checked, there
      // just was no Discogs release to link) — so the cell closes `done` the moment
      // the backfill RAN (`discogsRan`, the `backfill_discogs_attempted_at` stamp),
      // whether or not it linked a release. Grey/`open` means ONE thing: not run yet.
      // No manual trigger — the agent resolves the release; clicking opens the link
      // (still only actionable when there's a release to open).
      actionable: Boolean(row.discogsReleaseUrl),
      gated: false,
      hint: row.discogsReleaseUrl
        ? "Open the Discogs release"
        : row.discogsRan
          ? "Checked — no Discogs release found"
          : "Discogs lookup hasn't run yet",
      state: row.discogsRan ? "done" : "open",
      statusLabel: row.discogsReleaseUrl
        ? "Linked"
        : row.discogsRan
          ? "Checked — no release"
          : "Pending",
    },
    enrich: {
      actionable: true,
      gated: false,
      hint: "Audio analysis by the on-box enrichment cron",
      state:
        row.enrichmentStatus === "done"
          ? "done"
          : row.enrichmentStatus === "processing"
            ? "running"
            : "open",
      statusLabel:
        row.enrichmentStatus === "done"
          ? "Enriched"
          : row.enrichmentStatus === "processing"
            ? "Enriching…"
            : "Enrich",
    },
    lastfm: {
      // Same workflow-tracker rule as Discogs. The Last.fm love runs on its own (the
      // publish fan-out loves on add; the backfill loves older findings) — no board
      // click. The cell closes `done` the moment the backfill RAN (`lastfmRan`, the
      // `backfill_lastfm_attempted_at` stamp), whether or not the love landed; grey/
      // `open` means only "not run yet". `lastfmLoved` (the `backfill_lastfm_done_at`
      // stamp a successful `track.love` writes) only refines the label.
      actionable: false,
      gated: false,
      hint: row.lastfmLoved
        ? "Loved on Last.fm"
        : row.lastfmRan
          ? "Checked — not loved on Last.fm"
          : "Last.fm love hasn't run yet",
      state: row.lastfmRan ? "done" : "open",
      statusLabel: row.lastfmLoved ? "Loved" : row.lastfmRan ? "Checked — not loved" : "Pending",
    },
    mixtape: {
      actionable: true,
      gated: false,
      hint: row.mixtapes.length > 0 ? "On a mixtape — open the picker" : "Add to a mixtape",
      state: onTape ? "done" : inDraftTape ? "partial" : "open",
      statusLabel: onTape ? "On a tape" : inDraftTape ? "In a draft" : "Add",
    },
    note: {
      actionable: true,
      gated: false,
      hint: "The finding's note — shows on its log page",
      state: note ? "done" : "open",
      statusLabel: note ? "Noted" : "Note",
    },
    observation: {
      actionable: true,
      gated: false,
      hint: rendered
        ? "Play the spoken observation"
        : row.hasContextNote
          ? "Context gathered — not voiced yet"
          : "No observation rendered yet",
      // Context-in-hand-but-unvoiced is the real in-between.
      state: rendered ? "done" : row.hasContextNote ? "partial" : "open",
      statusLabel: rendered ? "Heard" : row.hasContextNote ? "Ready to voice" : "No clip",
    },
    tag: {
      actionable: true,
      gated: false,
      hint: "Place on the vibe map",
      state: tagged ? "done" : "open",
      statusLabel: tagged ? (galaxy ? GALAXIES[galaxy].name : "Tagged") : "Tag",
    },
    tiktok: publishStep(row, "tiktok"),
    video: {
      // Agent-rendered; clicking previews when there's a clip, otherwise it waits.
      actionable: Boolean(row.videoUrl),
      gated: false,
      hint: row.videoUrl ? "Preview the clip" : "No clip rendered yet",
      state: row.videoUrl ? "done" : "open",
      statusLabel: row.videoUrl ? "Filmed" : "No clip",
    },
    youtube: publishStep(row, "youtube"),
  };

  return STEP_DEFS.map((def) => ({
    Icon: def.Icon,
    key: def.key,
    kind: def.kind,
    label: def.label,
    ...partials[def.key],
  }));
}

/** Dispatch a step's click to the right board action. */
export function runStep(step: BoardStep, row: BoardRow, actions: BoardActions): void {
  switch (step.key) {
    case "enrich":
      return actions.onEnrich(row);
    case "tag":
      return actions.onTag(row);
    case "context":
      return actions.onContext(row);
    case "observation":
      return actions.onObservation(row);
    case "note":
      return actions.onNote(row);
    case "youtube":
      return actions.onPush(row, "youtube");
    case "tiktok":
      return actions.onPush(row, "tiktok");
    case "mixtape":
      return actions.onMixtape(row);
    case "video":
      if (row.videoUrl) {
        actions.onPreview(row);
      }
      return;
    case "discogs":
      if (row.discogsReleaseUrl) {
        window.open(row.discogsReleaseUrl, "_blank", "noopener,noreferrer");
      }
      return;
    case "lastfm":
      return;
  }
}
