import {
  BroadcastIcon,
  CassetteTapeIcon,
  FileTextIcon,
  FilmSlateIcon,
  FingerprintIcon,
  HeartIcon,
  type IconWeight,
  MicrophoneIcon,
  NotePencilIcon,
  VinylRecordIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { isStaleTikTokDraft, tikTokDraftAgeHours } from "@fluncle/contracts/util";
import { type ComponentType } from "react";
import { TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
import { type BlockedOn, type Stage } from "@/lib/track-stage";
import { type BoardRow } from "@/components/admin/use-publish";

export type StepIcon = ComponentType<{ className?: string; weight?: IconWeight }>;

export type StepKey =
  | "enrich"
  | "embedding"
  | "discogs"
  | "video"
  | "context"
  | "observation"
  | "note"
  | "youtube"
  | "tiktok"
  | "mixtape"
  | "socials";

export type StepKind = "auto" | "human";

export type StepState = "open" | "running" | "partial" | "done" | "stale" | "planned";

export type BoardActions = {
  onEnrich: (row: BoardRow) => void;

  onCaptureSource: (row: BoardRow) => void;
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

  label: string;

  state: StepState;

  statusLabel: string;

  Icon: StepIcon;

  hint: string;

  actionable: boolean;

  gated: boolean;
};

export type BoardEntry = {
  row: BoardRow;
  stage: Stage;
  blockedOn: BlockedOn;
  steps: BoardStep[];
};

export type BoardProps = {
  entries: BoardEntry[];
  actions: BoardActions;
};

const STEP_DEFS: { key: StepKey; kind: StepKind; label: string; Icon: StepIcon }[] = [
  { Icon: BroadcastIcon, key: "socials", kind: "auto", label: "Auto socials" },
  { Icon: VinylRecordIcon, key: "discogs", kind: "auto", label: "Discogs" },
  { Icon: WaveformIcon, key: "enrich", kind: "auto", label: "Enrich" },
  { Icon: FingerprintIcon, key: "embedding", kind: "auto", label: "Embeddings" },
  { Icon: FileTextIcon, key: "context", kind: "auto", label: "Context" },
  { Icon: NotePencilIcon, key: "note", kind: "auto", label: "Note" },
  { Icon: MicrophoneIcon, key: "observation", kind: "auto", label: "Observation" },
  { Icon: FilmSlateIcon, key: "video", kind: "auto", label: "Video" },
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

  const staleDraft = post ? isStaleTikTokDraft(post, now) : false;
  const staleHours = post ? (tikTokDraftAgeHours(post, now) ?? 0) : 0;

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

export type SocialBreakdownItem = { key: string; label: string; done: boolean; Icon: StepIcon };

export function automatedSocialsBreakdown(row: BoardRow): SocialBreakdownItem[] {
  return [
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
}

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
    hint: "Automated socials — the Last.fm love",
    state,
    statusLabel,
  };
}

type BoardStepPartial = Pick<BoardStep, "state" | "statusLabel" | "hint" | "actionable" | "gated">;

function discogsBoardStep(row: BoardRow): BoardStepPartial {
  const linked = Boolean(row.discogsReleaseUrl);
  return {
    actionable: linked,
    gated: false,
    hint: linked
      ? "Open the Discogs release"
      : row.discogsRan
        ? "Checked — no Discogs release found"
        : "Discogs lookup hasn't run yet",
    state: linked || row.discogsRan ? "done" : "open",
    statusLabel: linked ? "Linked" : row.discogsRan ? "Checked — no release" : "Pending",
  };
}

function enrichBoardStep(row: BoardRow): BoardStepPartial {
  const done = row.enrichmentStatus === "done";
  const running = row.enrichmentStatus === "processing";
  return {
    actionable: true,
    gated: false,
    hint: "Audio analysis by the on-box enrichment cron",
    state: done ? "done" : running ? "running" : "open",
    statusLabel: done ? "Enriched" : running ? "Enriching…" : "Enrich",
  };
}

function mixtapeBoardStep(onTape: boolean, inPlan: boolean): BoardStepPartial {
  return {
    actionable: true,
    gated: false,
    hint: onTape ? "On a mixtape: open the plan picker" : "Add to a plan",
    state: onTape ? "done" : inPlan ? "partial" : "open",
    statusLabel: onTape ? "On a tape" : inPlan ? "In a plan" : "Add",
  };
}

function noteBoardStep(note: string | undefined, noteRan: boolean): BoardStepPartial {
  return {
    actionable: true,
    gated: false,
    hint: note
      ? "The finding's note — shows on its log page"
      : noteRan
        ? "Auto-note ran — no note yet; write one"
        : "No note yet — write one, or the auto-note cron will",
    state: note ? "done" : "open",
    statusLabel: note ? "Noted" : noteRan ? "Checked — no note" : "Note",
  };
}

function observationBoardStep(rendered: boolean, hasContextNote: boolean): BoardStepPartial {
  return {
    actionable: true,
    gated: false,
    hint: rendered
      ? "Play the spoken observation"
      : hasContextNote
        ? "Context gathered — not voiced yet"
        : "No observation rendered yet",
    state: rendered ? "done" : hasContextNote ? "partial" : "open",
    statusLabel: rendered ? "Heard" : hasContextNote ? "Ready to voice" : "No clip",
  };
}

function videoBoardStep(videoUrl: string | undefined): BoardStepPartial {
  return {
    actionable: Boolean(videoUrl),
    gated: false,
    hint: videoUrl ? "Preview the clip" : "No clip rendered yet",
    state: videoUrl ? "done" : "open",
    statusLabel: videoUrl ? "Filmed" : "No clip",
  };
}

export function boardSteps(row: BoardRow, now: number = Date.now()): BoardStep[] {
  const note = row.note?.trim();
  const rendered = Boolean(row.observationAudioUrl);

  const onTape = row.mixtapes.length > 0;
  const inPlan = !onTape && row.plans.length > 0;

  const partials: Record<StepKey, BoardStepPartial> = {
    context: {
      actionable: true,
      gated: false,
      hint: row.hasContextNote ? "View the context note" : "No context gathered yet",
      state: row.hasContextNote ? "done" : "open",
      statusLabel: row.hasContextNote ? "Context" : "No context",
    },
    discogs: discogsBoardStep(row),
    embedding: {
      actionable: true,
      gated: false,
      hint: row.hasEmbedding
        ? "MuQ audio embedding captured — open the capture source"
        : "No embedding yet — open the capture source (pin an upload if the gate keeps refusing)",
      state: row.hasEmbedding ? "done" : "open",
      statusLabel: row.hasEmbedding ? "Embedded" : "Pending",
    },
    enrich: enrichBoardStep(row),
    mixtape: mixtapeBoardStep(onTape, inPlan),
    note: noteBoardStep(note, row.noteRan),
    observation: observationBoardStep(rendered, row.hasContextNote),
    socials: socialsStep(row),
    tiktok: publishStep(row, "tiktok", now),
    video: videoBoardStep(row.videoUrl),
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

export function runStep(step: BoardStep, row: BoardRow, actions: BoardActions): void {
  switch (step.key) {
    case "enrich":
      return actions.onEnrich(row);
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
    case "embedding":
      return actions.onCaptureSource(row);
    case "socials":
      return;
  }
}
