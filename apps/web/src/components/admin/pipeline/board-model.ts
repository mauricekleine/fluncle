import {
  BroadcastIcon,
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
import { isStaleTikTokDraft, tikTokDraftAgeHours } from "@fluncle/contracts/util";
import { type ComponentType } from "react";
import { SpotifyIcon, TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
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
  | "socials";

/** Who advances the step: an agent (`auto`) or the operator (`human`). */
export type StepKind = "auto" | "human";

/**
 * open    — nothing yet; for a human step this is your move (when not gated).
 * running — an agent step in flight (enrichment processing).
 * partial — touched, not closed (a pushed-but-not-live draft; context gathered but
 *           not voiced; a finding pencilled into a plan).
 * done    — closed.
 * stale   — pushed but the push has almost certainly bounced: a TikTok inbox draft
 *           past TikTok's 24h window (Postiz reports success, TikTok drops the 6th+
 *           pending draft silently). Your move again — re-push — so it never reads as
 *           gone-out. Distinct from `open` (never pushed) and `partial` (in-flight).
 * planned — designed-in, not wired yet; ghosted, never actionable.
 */
export type StepState = "open" | "running" | "partial" | "done" | "stale" | "planned";

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

// The canonical order + identity of every step. Agents first, then your hands.
// Within agents the order reads as the pipeline settles: the catalogue links
// (Last.fm, Discogs), then the per-finding chain Enrich → Context → Note →
// Observation → Video. NOTE sits among the agents in anticipation of auto-drafted
// notes (the _Auto-drafted finding notes_ slice); until that lands it is still
// operator-written, but it lives among the agents it will join. Within your hands:
// Tag, then the social pushes, then the mixtape.
const STEP_DEFS: { key: StepKey; kind: StepKind; label: string; Icon: StepIcon }[] = [
  { Icon: BroadcastIcon, key: "socials", kind: "auto", label: "Auto socials" },
  { Icon: VinylRecordIcon, key: "discogs", kind: "auto", label: "Discogs" },
  { Icon: WaveformIcon, key: "enrich", kind: "auto", label: "Enrich" },
  { Icon: FileTextIcon, key: "context", kind: "auto", label: "Context" },
  { Icon: NotePencilIcon, key: "note", kind: "auto", label: "Note" },
  { Icon: MicrophoneIcon, key: "observation", kind: "auto", label: "Observation" },
  { Icon: FilmSlateIcon, key: "video", kind: "auto", label: "Video" },
  { Icon: CrosshairIcon, key: "tag", kind: "human", label: "Tag" },
  { Icon: YoutubeIcon, key: "youtube", kind: "human", label: "YouTube" },
  { Icon: TiktokIcon, key: "tiktok", kind: "human", label: "TikTok" },
  { Icon: CassetteTapeIcon, key: "mixtape", kind: "human", label: "Mixtape" },
];

function publishStep(
  row: BoardRow,
  platform: "youtube" | "tiktok",
  now: number,
): Pick<BoardStep, "state" | "statusLabel" | "hint" | "actionable" | "gated"> {
  const post = row.posts.find((entry) => entry.platform === platform);
  const status = post?.status;
  const hasLiveUrl = Boolean(post?.url);
  // A TikTok inbox draft past the 24h window has almost certainly bounced (Postiz
  // reports the push a success but TikTok silently drops the 6th+ pending draft), so
  // it re-opens as `stale` — your move again — rather than reading `partial`/gone-out
  // forever. The shared `isStaleTikTokDraft` rule is the one source of that cutoff.
  const staleDraft = post ? isStaleTikTokDraft(post, now) : false;
  const staleHours = post ? (tikTokDraftAgeHours(post, now) ?? 0) : 0;
  // Live only closes the circuit once a public URL is recorded; YouTube auto-posts
  // and TikTok is finished in-app, so both land "published" with the link missing —
  // a partial, not done. A failed push re-opens it as a retry; a bounced draft as stale.
  const state: StepState = staleDraft
    ? "stale"
    : status === "published"
      ? hasLiveUrl
        ? "done"
        : "partial"
      : status === "draft" || status === "scheduled"
        ? "partial"
        : "open";
  const statusLabel = staleDraft
    ? `Stale ${staleHours}h`
    : status === "published"
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
  const hint = gated
    ? "No video yet — render first"
    : staleDraft
      ? `Draft stale ${staleHours}h — likely bounced; re-push`
      : `${label} publish`;

  return {
    actionable: !gated,
    gated,
    hint,
    state,
    statusLabel,
  };
}

/** One line in the automated-socials Popover breakdown. */
export type SocialBreakdownItem = { key: string; label: string; done: boolean; Icon: StepIcon };

/**
 * The per-action breakdown behind the automated-socials cell: the Last.fm love plus each
 * of the finding's artist Spotify/YouTube auto-follow targets. Powers the board cell's
 * Popover (each line an icon + a done/pending check). Kept beside the cell derivation so
 * the two never disagree.
 */
export function automatedSocialsBreakdown(row: BoardRow): SocialBreakdownItem[] {
  const items: SocialBreakdownItem[] = [
    {
      Icon: HeartIcon,
      done: row.lastfmRan,
      key: "lastfm",
      label: row.lastfmLoved
        ? "Last.fm — loved"
        : row.lastfmRan
          ? "Last.fm — checked, not loved"
          : "Last.fm — pending",
    },
  ];

  for (const target of row.artistFollows ?? []) {
    const name = target.platform === "spotify" ? "Spotify" : "YouTube";
    items.push({
      Icon: target.platform === "spotify" ? SpotifyIcon : YoutubeIcon,
      done: target.followed,
      key: target.platform,
      label: `${name} — ${target.followed ? "following the artist" : "not followed yet"}`,
    });
  }

  return items;
}

// The automated-socials cell (the repurposed LFM cell): an aggregate of the finding's
// hands-off "champion the artist" actions — the Last.fm love (workflow-tracker rule:
// `done` once the backfill RAN) + each artist Spotify/YouTube auto-follow. `done` = all
// actioned, `open` = none, `partial` = some. Not actionable (the follows are automated);
// the cell's Popover shows the per-platform breakdown on hover.
function socialsStep(
  row: BoardRow,
): Pick<BoardStep, "state" | "statusLabel" | "hint" | "actionable" | "gated"> {
  const items = automatedSocialsBreakdown(row);
  const doneCount = items.filter((item) => item.done).length;
  const state: StepState =
    doneCount === 0 ? "open" : doneCount === items.length ? "done" : "partial";
  const statusLabel =
    state === "done" ? "All" : state === "partial" ? `${doneCount}/${items.length}` : "Pending";

  return {
    actionable: false,
    gated: false,
    hint: "Automated socials — the Last.fm love + Spotify/YouTube artist follows",
    state,
    statusLabel,
  };
}

/**
 * Derive every step for one finding. Pure over the row + an injected clock (`now`,
 * defaulting to the wall clock): the only time dependence is the TikTok stale-draft
 * cutoff. Reads the row's own fields plus its social posts and mixtape memberships,
 * exactly like the live board's cells, so the variants never drift from the real state.
 */
export function boardSteps(row: BoardRow, now: number = Date.now()): BoardStep[] {
  const tagged = row.vibeX !== undefined && row.vibeY !== undefined;
  const galaxy =
    row.galaxy?.key ??
    (row.vibeX !== undefined && row.vibeY !== undefined
      ? galaxyForVibe(row.vibeX, row.vibeY)
      : undefined);
  const note = row.note?.trim();
  const rendered = Boolean(row.observationAudioUrl);
  // Every mixtape membership is a minted checkpoint now (drafts retired); a plan
  // membership is the pencilled-in in-between.
  const onTape = row.mixtapes.length > 0;
  const inPlan = !onTape && row.plans.length > 0;

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
      // The board is a WORKFLOW tracker, not a data-existence tracker. The cell
      // closes `done` once the lookup has resolved a release OR ran without finding
      // one — both are a SUCCESS (the workflow checked). A release can be linked by
      // EITHER path: the on-add resolve (publishTrack writes `in_release_id` directly,
      // without ever stamping `backfill_discogs_attempted_at`) or the backfill sweep
      // (which stamps `discogsRan`, then SKIPS already-linked findings forever). So a
      // finding resolved on add carries `discogsReleaseUrl` but NOT `discogsRan` — it
      // must still read `done`, or a linked release renders as an un-filled "Pending"
      // cell. Hence: linked (either path) OR ran ⇒ done. Grey/`open` means ONE thing:
      // never resolved AND never swept. No manual trigger — the agent resolves the
      // release; clicking opens the link (only actionable when there's one to open).
      actionable: Boolean(row.discogsReleaseUrl),
      gated: false,
      hint: row.discogsReleaseUrl
        ? "Open the Discogs release"
        : row.discogsRan
          ? "Checked — no Discogs release found"
          : "Discogs lookup hasn't run yet",
      state: row.discogsReleaseUrl || row.discogsRan ? "done" : "open",
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
    mixtape: {
      actionable: true,
      gated: false,
      hint: onTape ? "On a mixtape: open the plan picker" : "Add to a plan",
      state: onTape ? "done" : inPlan ? "partial" : "open",
      statusLabel: onTape ? "On a tape" : inPlan ? "In a plan" : "Add",
    },
    note: {
      // An `auto` step (the auto-note cron authors it) that stays `actionable` so the
      // operator can still hand-write or override. `done` = a note exists (the
      // deliverable — auto-authored OR operator-typed); `noteRan`
      // (`backfill_note_attempted_at`) refines the grey state so a finding the cron
      // visited but couldn't fill reads "Checked — no note" rather than a bare "Note".
      // The operator override always wins: note_track fills an EMPTY note only.
      actionable: true,
      gated: false,
      hint: note
        ? "The finding's note — shows on its log page"
        : row.noteRan
          ? "Auto-note ran — no note yet; write one"
          : "No note yet — write one, or the auto-note cron will",
      state: note ? "done" : "open",
      statusLabel: note ? "Noted" : row.noteRan ? "Checked — no note" : "Note",
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
    socials: socialsStep(row),
    tag: {
      actionable: true,
      gated: false,
      hint: "Place on the vibe map",
      state: tagged ? "done" : "open",
      statusLabel: tagged ? (galaxy ? GALAXIES[galaxy].name : "Tagged") : "Tag",
    },
    tiktok: publishStep(row, "tiktok", now),
    video: {
      // Agent-rendered; clicking previews when there's a clip, otherwise it waits.
      actionable: Boolean(row.videoUrl),
      gated: false,
      hint: row.videoUrl ? "Preview the clip" : "No clip rendered yet",
      state: row.videoUrl ? "done" : "open",
      statusLabel: row.videoUrl ? "Filmed" : "No clip",
    },
    youtube: publishStep(row, "youtube", now),
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
    case "socials":
      return;
  }
}
