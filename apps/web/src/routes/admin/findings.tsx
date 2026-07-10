import { CassetteTapeIcon, CircleNotchIcon, PlusIcon, TrayIcon } from "@phosphor-icons/react";
import { isStaleTikTokDraft } from "@fluncle/contracts/util";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddFindingDialog } from "@/components/admin/add-finding-dialog";
import {
  AddToPlanDialog,
  type PlanTarget,
  type PlanTargetCue,
} from "@/components/admin/add-to-plan-dialog";
import { AdminShell } from "@/components/admin/admin-shell";
import {
  type BoardActions,
  type BoardEntry,
  boardSteps,
} from "@/components/admin/pipeline/board-model";
import { PipelineBoard } from "@/components/admin/pipeline/pipeline-board";
import { EnrichDialog } from "@/components/admin/enrich-dialog";
import { NoteDialog } from "@/components/admin/note-dialog";
import { ContextDialog, ObservationDialog } from "@/components/admin/observation-dialogs";
import { PLATFORMS } from "@/components/admin/platform-cell";
import { PushDialog } from "@/components/admin/push-dialog";
import { SubmissionsTray } from "@/components/admin/submissions-tray";
import { type BoardPage, type BoardRow, usePublish } from "@/components/admin/use-publish";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import { Dialog, DialogContent } from "@fluncle/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@fluncle/ui/components/empty";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listBackfillRanForTracks, listLastfmLovedForTracks } from "@/lib/server/backfill";
import { readCaptions } from "@/lib/server/captions";
import { listMixtapeMembershipsForTracks } from "@/lib/server/mixtapes";
import {
  getContextNote,
  getObservationScript,
  listContextNotePresenceForTracks,
} from "@/lib/server/observation-board";
import {
  getRecordingCues,
  listPlanMembershipsForTracks,
  listRecordings,
} from "@/lib/server/recordings";
import { listSocialPostsForTracks } from "@/lib/server/social";
import { getSpotifyAuthStatus, type SpotifyAuthStatus } from "@/lib/server/spotify";
import { listPendingSubmissions, type Submission } from "@/lib/server/submissions";
import { type BlockedOn, trackStage } from "@/lib/server/track-stage";
import { decodeTrackCursor, listEmbeddingPresenceForTracks, listTracks } from "@/lib/server/tracks";
import { cn } from "@/lib/utils";

// The findings board — the per-finding pipeline station at `/admin/findings`
// (the attention queue at `/admin` is the workspace home now; it deep-links here).
// This route owns the data (the social-joined infinite query), the filters
// (worklist + mixtape lens), and every stage dialog;
// the rendering is the PipelineBoard grid (components/admin/pipeline). Each finding
// is a row, each pipeline step a cell, the steps split into two column groups —
// Agents (an agent does it) and Yours (your hands) — because the pipeline isn't a
// strict chain: steps run in parallel, fail, and retry. A cell reads by SHAPE
// (round = agent, square = yours) and FILL (open → in-flight → done), and clicking
// it opens that step's dialog (Enrich → re-queue for the box cron; YouTube/TikTok →
// the publish loop). The board derives its steps from a pure model
// (pipeline/board-model) and wires every cell back to the dialogs through `actions`.
//
// Reads + writes go through the same gated admin API the CLI uses. This board is the
// single admin surface — it folded in the old Posts and Tag pages. (Manual vibe-map
// tagging has since been retired — MuQ audio embeddings supersede it — so the board's
// analysis lane now surfaces embedding presence where the Tag cell used to sit.)

const PAGE_SIZE = 50;

// The board's react-query cache key. Optimistic publish patches + window-focus
// refetch land on this one entry.
const BOARD_KEY = ["admin", "posts", "board"] as const;
// The Spotify connection-status cache for the reconnect banner.
const SPOTIFY_STATUS_KEY = ["admin", "spotify", "status"] as const;
// The pending-submissions cache for the candidates tray (and its header badge).
const SUBMISSIONS_KEY = ["admin", "submissions"] as const;
// The plan targets for the "Add to a plan" sheet.
const PLAN_TARGETS_KEY = ["admin", "plans", "targets"] as const;
// The lazily-read context_note for the Context cell's view dialog, keyed by trackId.
const CONTEXT_NOTE_KEY = ["admin", "context-note"] as const;
// The lazily-read observation script (transcript) for the Observation dialog, keyed by trackId.
const OBSERVATION_SCRIPT_KEY = ["admin", "observation-script"] as const;

// The worklists — a `blockedOn` filter (the next action) plus "all" and a "done"
// terminal bucket. The active one lives in `?stage` so it's deep-linkable and
// survives reload. The checklist columns show each stage's own state; this just
// narrows the rows to a focus ("show me everything still needing a video").
type Worklist = "all" | "needs-tagging" | "needs-video" | "ready-youtube" | "ready-tiktok" | "done";

// The worklists kept to the ones actually worked from: everything and the terminal
// "Live" bucket. The render/publish-readiness buckets were dropped as noise — each
// stage's own cell already shows its state — and the "Needs tagging" bucket retired
// with the vibe map (MuQ embeddings supersede manual tagging; there's no board action
// left to advance it). ?stage values stay back-compatible: an old link to a dropped
// bucket validates back to "all" (WORKLIST_KEYS no longer has it).
type WorklistDef = { blockedOn?: BlockedOn; key: Worklist; label: string };
// The "all" worklist is the canonical fallback when no key matches; naming it
// keeps the fallback statically defined (not an unchecked index).
const ALL_WORKLIST: WorklistDef = { key: "all", label: "All" };
const WORKLISTS: WorklistDef[] = [ALL_WORKLIST, { blockedOn: null, key: "done", label: "Live" }];

const WORKLIST_KEYS = new Set(WORKLISTS.map((worklist) => worklist.key));

// The mixtape lens — a SECOND filter axis, ANDed with the worklist. A finding is
// "on a tape" once it lands in a minted checkpoint (every mixtape membership is
// published/distributing now — drafts retired for plans), "in a plan" while it is
// only pencilled into a plan's cues, and "open" when it's in neither. Powers the
// "show me what I haven't used yet, to build a set around it" view; deep-linked via
// ?mix so it survives reload. (An old ?mix=draft link validates back to "all".)
type MixState = "open" | "plan" | "tape";
type MixFilter = "all" | MixState;

const MIX_FILTERS: { key: MixFilter; label: string }[] = [
  { key: "all", label: "Any tape" },
  { key: "open", label: "Not on a tape" },
  { key: "plan", label: "In a plan" },
  { key: "tape", label: "On a tape" },
];

const MIX_FILTER_KEYS = new Set(MIX_FILTERS.map((filter) => filter.key));

// A finding is "on a tape" the moment it's in a minted checkpoint (every mixtape
// membership is one — the coordinate is committed); "plan" while it is only
// pencilled into a plan's cues.
function mixtapeStateOf(row: BoardRow): MixState {
  if (row.mixtapes.length > 0) {
    return "tape";
  }
  return row.plans.length > 0 ? "plan" : "open";
}

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every admin server function re-checks the grant — the page guard only protects
// the render, not the RPC behind a server function.
const fetchBoard = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string }) => data)
  .handler(async ({ data }): Promise<BoardPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const page = await listTracks({
      cursor: decodeTrackCursor(data.cursor ?? null),
      limit: PAGE_SIZE,
      order: "desc",
    });
    const trackIds = page.tracks.map((track) => track.trackId);
    // Batch fetches — one query each for the whole page, no N+1: the per-platform
    // posts, the mixtape + plan memberships (which tapes each finding is already
    // on, and which plans it's pencilled into), which
    // findings carry an internal context_note (the Context column status — pulled
    // admin-only since context_note never rides the public track contract), which
    // carry a MuQ audio embedding (the Embeddings column status — `embedding_json`
    // presence, admin-only for the same reason), and the Discogs/Last.fm backfill
    // RAN-stamps (`*_attempted_at`) + the Last.fm LOVED-stamp (`backfill_lastfm_done_at`).
    // The board's Discogs/Last.fm cells are workflow trackers: `done` once the backfill
    // ran (whether or not it found data), grey only while it's never run — the
    // ran-stamp drives the cell, the data-stamp (release url / loved) only refines the
    // label.
    const [
      posts,
      mixtapes,
      plans,
      contextNotes,
      embeddings,
      discogsRan,
      lastfmRan,
      lastfmLoved,
      noteRan,
    ] = await Promise.all([
      listSocialPostsForTracks(trackIds),
      listMixtapeMembershipsForTracks(trackIds),
      listPlanMembershipsForTracks(trackIds),
      listContextNotePresenceForTracks(trackIds),
      listEmbeddingPresenceForTracks(trackIds),
      listBackfillRanForTracks(trackIds, "discogs"),
      listBackfillRanForTracks(trackIds, "lastfm"),
      listLastfmLovedForTracks(trackIds),
      listBackfillRanForTracks(trackIds, "note"),
    ]);

    return {
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
      tracks: page.tracks.map((track) => ({
        ...track,
        discogsRan: discogsRan.has(track.trackId),
        hasContextNote: contextNotes.has(track.trackId),
        hasEmbedding: embeddings.has(track.trackId),
        lastfmLoved: lastfmLoved.has(track.trackId),
        lastfmRan: lastfmRan.has(track.trackId),
        mixtapes: mixtapes[track.trackId] ?? [],
        noteRan: noteRan.has(track.trackId),
        plans: plans[track.trackId] ?? [],
        posts: posts[track.trackId] ?? [],
      })),
    };
  });

// The plans the board's "Add to a plan" sheet can pencil findings into — every
// plan with its CURRENT cues in the `replace_recording_cues` body shape, so the
// dialog's append replays them untouched (non-finding snapshot rows and marked
// start times included). Lazily fetched the first time the sheet opens, then
// cached + focus-refetched.
const fetchPlanTargets = createServerFn({ method: "GET" }).handler(
  async (): Promise<PlanTarget[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const plans = await listRecordings({ kind: "plan" });

    return Promise.all(
      plans.map(async (plan) => ({
        cues: (await getRecordingCues(plan.id)).map(
          (cue): PlanTargetCue => ({
            artistsText: cue.artists_text ?? undefined,
            findingId: cue.finding_id ?? undefined,
            startMs: cue.start_ms ?? undefined,
            titleText: cue.title_text ?? undefined,
          }),
        ),
        id: plan.id,
        title: plan.title,
      })),
    );
  },
);

// Lazy caption read — only when the operator copies a finding's caption, never
// preloaded for the whole page. Reads the public note.txt server-side (no CORS;
// works in dev too, the binding is just empty there).
const fetchCaption = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data }): Promise<{ caption: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const captions = await readCaptions([data.logId]);

    return { caption: captions[data.logId] ?? "" };
  });

// Lazy context-note read — only when the operator opens a finding's Context cell to
// view the firecrawl-derived facts that fuel its observation script. Internal fuel,
// so it stays on this gated admin path and off
// the public track contract; never preloaded for the whole page.
const fetchContextNote = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<{ contextNote: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { contextNote: await getContextNote(data.trackId) };
  });

// Lazy observation-script read — only when the operator opens a finding's
// Observation dialog, to read the spoken transcript under the audio player. The
// script mirrors the R2 observation.json `text` on the row (written by the observe
// render); internal like the context note, so it rides this gated admin path and
// never the public track contract. Never preloaded for the whole page.
const fetchObservationScript = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<{ script: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { script: await getObservationScript(data.trackId) };
  });

// The Spotify connection light. Read-only (no token refresh) and focus-refetched,
// so the moment a publish/search trips invalid_grant and clears the stored token,
// tabbing back to the board surfaces the Reconnect banner. See spotify.ts.
const fetchSpotifyStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SpotifyAuthStatus> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return getSpotifyAuthStatus();
  },
);

// The candidates tray's pending queue — a small scoped read (pending rows only),
// fetched on mount for the header badge's honest count and focus-refetched so a
// fresh crew submission surfaces when the operator tabs back. The writes
// (approve = the add path + the status flip, reject) go through the operator-tier
// oRPC routes, same as the CLI.
const fetchSubmissions = createServerFn({ method: "GET" }).handler(
  async (): Promise<Submission[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listPendingSubmissions();
  },
);

type BoardSearch = { mix: MixFilter; stage: Worklist; submission?: string };

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/findings")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    mix:
      typeof search.mix === "string" && MIX_FILTER_KEYS.has(search.mix as MixFilter)
        ? (search.mix as MixFilter)
        : "all",
    stage:
      typeof search.stage === "string" && WORKLIST_KEYS.has(search.stage as Worklist)
        ? (search.stage as Worklist)
        : "all",
    // The attention queue's submission-row deep-link (`?submission=<id>`): present ⇒
    // open the review tray with that candidate focused. A bare `?submission=` (the
    // pure model's fallback when the row had no id) still opens the tray.
    ...(typeof search.submission === "string" ? { submission: search.submission } : {}),
  }),
  beforeLoad: async () => {
    await ensureAdmin();
  },
  loader: async () => {
    const board = await fetchBoard({ data: {} });
    return { board };
  },
  component: AdminBoardPage,
});

function AdminBoardPage() {
  const { board: initial } = Route.useLoaderData();
  const {
    mix: activeMix,
    stage: activeWorklist,
    submission: focusSubmissionId,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // The board reads through react-query so it refetches on window focus — when the
  // operator tabs back from TikTok/YouTube, the per-platform statuses come back
  // fresh without a manual reload. Seeded with the SSR loader page so the first
  // paint is instant and no client fetch fires on mount.
  const {
    data,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: { pageParams: [undefined], pages: [initial] },
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchBoard({ data: { cursor: pageParam } }),
    queryKey: BOARD_KEY,
    refetchOnWindowFocus: true,
  });

  const rows = useMemo(() => data?.pages.flatMap((page) => page.tracks) ?? [], [data]);

  const { busy, error, pushDraft, setError, setStatus } = usePublish(BOARD_KEY);

  // Dialogs are keyed by identity (not a row snapshot) so they always render the
  // LIVE row — right after a push the cache patches, the row updates, and the open
  // dialog shows the next step without reopening.
  const [enrichId, setEnrichId] = useState<string | undefined>();
  const [push, setPush] = useState<{ platformKey: string; trackId: string } | undefined>();
  const [preview, setPreview] = useState<BoardRow | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichError, setEnrichError] = useState<string | undefined>();
  const [noteId, setNoteId] = useState<string | undefined>();
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | undefined>();
  // The two audio-observation view cells (Context · Observation). View-only for now
  // — backfill (authoring + the observe render) needs an agent-authored script via
  // the observe endpoint, so the board reflects status and lets the operator read
  // the context note / play the observation; generating is left to the agent.
  const [contextId, setContextId] = useState<string | undefined>();
  const [observationId, setObservationId] = useState<string | undefined>();

  // The web intake: [Add finding] is the
  // board's primary header action; the candidates tray sits beside it as a quiet
  // sheet. Both land on the same publish path the CLI uses, so a fresh add appears
  // at the board's top on invalidation with its enrichment cells still open — the
  // crons fill them in.
  const [addOpen, setAddOpen] = useState(false);
  // Seed the tray open from the attention-queue deep-link (`?submission=<id>`) so a
  // landing straight from the /admin queue row shows the candidate at once.
  const [trayOpen, setTrayOpen] = useState(() => focusSubmissionId !== undefined);

  // A deep-link that arrives after mount (the operator clicks a queue row in another
  // tab, or navigates in-app) still opens the tray.
  useEffect(() => {
    if (focusSubmissionId !== undefined) {
      setTrayOpen(true);
    }
  }, [focusSubmissionId]);

  // Closing the tray drops the deep-link param so a reload/back doesn't re-open it.
  const onTrayOpenChange = useCallback(
    (open: boolean) => {
      setTrayOpen(open);
      if (!open && focusSubmissionId !== undefined) {
        void navigate({ search: (previous) => ({ ...previous, submission: undefined }) });
      }
    },
    [focusSubmissionId, navigate],
  );

  const { data: submissions = [], isFetching: submissionsFetching } = useQuery({
    queryFn: () => fetchSubmissions(),
    queryKey: SUBMISSIONS_KEY,
    refetchOnWindowFocus: true,
  });

  const onFindingAdded = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY });
  }, [queryClient]);

  // An approve also publishes, so the board refetches alongside the tray.
  const onSubmissionsChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SUBMISSIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY });
  }, [queryClient]);

  const rowFor = useCallback(
    (trackId?: string) => (trackId ? rows.find((row) => row.trackId === trackId) : undefined),
    [rows],
  );
  const enrichRow = rowFor(enrichId);
  const noteRow = rowFor(noteId);
  const contextRow = rowFor(contextId);
  const observationRow = rowFor(observationId);
  const pushRow = rowFor(push?.trackId);
  const pushPlatform = push
    ? (PLATFORMS.find((platform) => platform.key === push.platformKey) ?? null)
    : null;

  // A failed load-more shouldn't be swallowed; surface it next to mutation errors
  // and use it to pause the infinite-scroll observer until a manual retry.
  const loadError = queryError
    ? queryError instanceof Error
      ? queryError.message
      : String(queryError)
    : undefined;
  const shownError = error ?? loadError;

  // Each row carries its derived stage so the worklist filter reads the same
  // source as the lifecycle model. In-memory filtering is fine at current scale.
  const staged = useMemo(() => rows.map((row) => ({ ...trackStage(row), row })), [rows]);

  const worklistDef = WORKLISTS.find((worklist) => worklist.key === activeWorklist) ?? ALL_WORKLIST;
  // Both filters AND together: the worklist narrows by pipeline stage, the mixtape
  // lens by tape membership. In-memory, like the worklist — fine at current scale.
  const visible = useMemo(
    () =>
      staged.filter(
        (entry) =>
          (worklistDef.key === "all" || entry.blockedOn === worklistDef.blockedOn) &&
          (activeMix === "all" || mixtapeStateOf(entry.row) === activeMix),
      ),
    [activeMix, staged, worklistDef],
  );

  // The board entries every variant reads — the filtered findings plus their derived
  // lifecycle position and full step list (the shared model). One derivation feeds
  // the table, the constellation, the lanes, all of them.
  const entries = useMemo<BoardEntry[]>(
    () =>
      visible.map(({ blockedOn, row, stage }) => ({
        blockedOn,
        row,
        stage,
        steps: boardSteps(row),
      })),
    [visible],
  );

  // Each axis's pill counts reflect the OTHER axis's active filter, so a pill's
  // number is exactly how many rows you'd see if you clicked it. Worklist counts are
  // taken over the mixtape-filtered set; mix counts over the worklist-filtered set.
  const byMix = useMemo(
    () => staged.filter((entry) => activeMix === "all" || mixtapeStateOf(entry.row) === activeMix),
    [activeMix, staged],
  );
  const byWorklist = useMemo(
    () =>
      staged.filter(
        (entry) => worklistDef.key === "all" || entry.blockedOn === worklistDef.blockedOn,
      ),
    [staged, worklistDef],
  );

  const counts = useMemo(() => {
    const byBlocked = new Map<BlockedOn, number>();
    for (const entry of byMix) {
      byBlocked.set(entry.blockedOn, (byBlocked.get(entry.blockedOn) ?? 0) + 1);
    }
    return (worklist: (typeof WORKLISTS)[number]) =>
      worklist.key === "all" ? byMix.length : (byBlocked.get(worklist.blockedOn ?? null) ?? 0);
  }, [byMix]);

  const mixCounts = useMemo(() => {
    const byState = new Map<MixState, number>();
    for (const entry of byWorklist) {
      const state = mixtapeStateOf(entry.row);
      byState.set(state, (byState.get(state) ?? 0) + 1);
    }
    return (filter: MixFilter) =>
      filter === "all" ? byWorklist.length : (byState.get(filter) ?? 0);
  }, [byWorklist]);

  // Advisory pending-draft count among loaded rows — surfaced inside the TikTok
  // push dialog (cap 5/24h), not in the header. A STALE draft (past the 24h window)
  // has already left the inbox one way or another — bounced or aged out — so it no
  // longer occupies a cap slot and is excluded from the count.
  const tiktokPending = useMemo(() => {
    const now = Date.now();

    return rows.filter((row) =>
      row.posts.some(
        (post) =>
          post.platform === "tiktok" && post.status === "draft" && !isStaleTikTokDraft(post, now),
      ),
    ).length;
  }, [rows]);

  const setWorklist = useCallback(
    (next: Worklist) => {
      void navigate({ search: (prev) => ({ ...prev, stage: next }) });
    },
    [navigate],
  );

  const setMix = useCallback(
    (next: MixFilter) => {
      void navigate({ search: (prev) => ({ ...prev, mix: next }) });
    },
    [navigate],
  );

  // The Mixtape stage cell opens a per-finding plan picker (keyed by trackId, like
  // the other dialogs). The plan targets load lazily the first time it opens.
  const [mixtapeId, setMixtapeId] = useState<string | undefined>();
  const mixtapeRow = rowFor(mixtapeId);

  const { data: planTargets = [], isFetching: plansFetching } = useQuery({
    enabled: mixtapeId !== undefined,
    queryFn: fetchPlanTargets,
    queryKey: PLAN_TARGETS_KEY,
    refetchOnWindowFocus: true,
  });

  // After a successful add: close the picker and refresh both the board (the Mixtape
  // cell's state) and the plan list (cue counts changed).
  const onAddedToPlan = useCallback(() => {
    setMixtapeId(undefined);
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY });
    void queryClient.invalidateQueries({ queryKey: PLAN_TARGETS_KEY });
  }, [queryClient]);

  // Patch one row's own fields in the board cache (the publish hook patches posts;
  // this is for the track-level fields tagging + enrichment change).
  const patchRow = useCallback(
    (trackId: string, patch: Partial<BoardRow>) => {
      queryClient.setQueryData<InfiniteData<BoardPage, string | undefined>>(BOARD_KEY, (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                tracks: page.tracks.map((row) =>
                  row.trackId === trackId ? { ...row, ...patch } : row,
                ),
              })),
            }
          : current,
      );
    },
    [queryClient],
  );

  const markCopied = useCallback((id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => (current === id ? undefined : current)), 1600);
  }, []);

  // Quick caption copy — lazily fetch the caption inside the tap and hand it to the
  // clipboard as a Promise, so the async read stays within the user gesture (iOS
  // rejects a write that lands after an awaited fetch).
  const copyCaption = useCallback(
    (row: BoardRow) => {
      if (!row.logId) {
        return;
      }

      setError(undefined);
      const text = fetchCaption({ data: { logId: row.logId } }).then(({ caption }) =>
        caption
          ? new Blob([caption], { type: "text/plain" })
          : Promise.reject(new Error("no caption")),
      );
      navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]).then(
        () => markCopied(row.trackId),
        () => setError("Couldn't copy the caption."),
      );
    },
    [markCopied, setError],
  );

  // The Spotify connection light — polled on focus so an expired authorization
  // (cleared server-side on invalid_grant) surfaces the moment the operator tabs
  // back. Reconnecting hands the browser to the gated auth-start, which returns the
  // Spotify authorize URL; the callback lands back on the board.
  const { data: spotifyStatus } = useQuery({
    queryFn: fetchSpotifyStatus,
    queryKey: SPOTIFY_STATUS_KEY,
    refetchOnWindowFocus: true,
  });

  const reconnectSpotify = useCallback(async () => {
    setError(undefined);

    try {
      const response = await fetch("/api/admin/spotify/auth/start", { credentials: "same-origin" });
      const data = (await response.json()) as { authUrl?: string };

      if (!response.ok || !data.authUrl) {
        throw new Error("Couldn't start the Spotify reconnect.");
      }

      window.location.href = data.authUrl;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [setError]);

  // The Context dialog's note text — lazily read the first time a Context cell is
  // opened, keyed per finding so each opens its own note (cached, never refetched).
  const { data: contextNoteData, isFetching: contextFetching } = useQuery({
    enabled: contextId !== undefined,
    queryFn: () => fetchContextNote({ data: { trackId: contextId as string } }),
    queryKey: [...CONTEXT_NOTE_KEY, contextId],
    staleTime: Number.POSITIVE_INFINITY,
  });

  // The Observation dialog's spoken transcript — lazily read the first time an
  // Observation cell is opened, keyed per finding (cached, never refetched).
  const { data: observationScriptData, isFetching: observationScriptFetching } = useQuery({
    enabled: observationId !== undefined,
    queryFn: () => fetchObservationScript({ data: { trackId: observationId as string } }),
    queryKey: [...OBSERVATION_SCRIPT_KEY, observationId],
    staleTime: Number.POSITIVE_INFINITY,
  });

  // The next finding in the current worklist — powers "Save & next" in the Tag and
  // Note dialogs so a batch is one sitting. Undefined at the end of the list, which
  // closes the dialog.
  const nextVisibleTrackId = useCallback(
    (currentTrackId: string): string | undefined => {
      const index = visible.findIndex((entry) => entry.row.trackId === currentTrackId);
      return index >= 0 && index + 1 < visible.length ? visible[index + 1]?.row.trackId : undefined;
    },
    [visible],
  );

  // Save the finding's note (the editorial "why" that feeds its log-page prose +
  // schema). Optimistically patches the row; "Save & next" walks the worklist.
  const saveNote = useCallback(
    async (note: string, advance?: boolean) => {
      if (!noteRow) {
        return;
      }

      setNoteSaving(true);
      setNoteError(undefined);

      try {
        const response = await fetch(`/api/admin/tracks/${noteRow.trackId}`, {
          body: JSON.stringify({ note }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });

        if (!response.ok) {
          throw new Error(`Save failed (${response.status})`);
        }

        patchRow(noteRow.trackId, { note: note.trim() || undefined });
        setNoteId(advance ? nextVisibleTrackId(noteRow.trackId) : undefined);
      } catch (caught) {
        setNoteError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setNoteSaving(false);
      }
    },
    [nextVisibleTrackId, noteRow, patchRow],
  );

  const runEnrichment = useCallback(async () => {
    if (!enrichRow?.logId) {
      return;
    }

    setEnrichBusy(true);
    setEnrichError(undefined);

    try {
      // Re-queue the finding for the on-box `fluncle-enrich` cron: PATCH the
      // status back to "pending" (queue-eligible). The cron picks it up on its
      // next ~5-min tick, analyzes on-box, and writes "done"/"failed" back.
      const response = await fetch(`/api/admin/tracks/${enrichRow.trackId}`, {
        body: JSON.stringify({ enrichmentStatus: "pending" }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(`Queue failed (${response.status})`);
      }

      // Optimistic: show it queued immediately. Window-focus refetch reconciles
      // with the cron's result.
      patchRow(enrichRow.trackId, { enrichmentStatus: "pending" });
      setEnrichId(undefined);
    } catch (caught) {
      setEnrichError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEnrichBusy(false);
    }
  }, [enrichRow, patchRow]);

  const onPush = useCallback(() => {
    if (push) {
      void pushDraft(push.trackId, push.platformKey);
    }
  }, [push, pushDraft]);

  const markLive = useCallback(
    async (url: string) => {
      if (!push) {
        return;
      }
      await setStatus(push.trackId, push.platformKey, "published", url);
      setPush(undefined);
    },
    [push, setStatus],
  );

  const markFailed = useCallback(async () => {
    if (!push) {
      return;
    }
    await setStatus(push.trackId, push.platformKey, "failed");
    setPush(undefined);
  }, [push, setStatus]);

  // Infinite scroll: auto-load when the sentinel nears the viewport bottom; the
  // button stays as a manual fallback. After a load error, auto mode pauses until a
  // manual retry clears it.
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage || isFetchingNextPage || loadError) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "320px" },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, loadError]);

  // The single action surface every variant opens its dialogs through — each maps a
  // finding to the right keyed-by-identity dialog the page already owns. Setters are
  // stable, so this never re-creates.
  const actions = useMemo<BoardActions>(
    () => ({
      onContext: (row) => setContextId(row.trackId),
      onEnrich: (row) => setEnrichId(row.trackId),
      onMixtape: (row) => setMixtapeId(row.trackId),
      onNote: (row) => setNoteId(row.trackId),
      onObservation: (row) => setObservationId(row.trackId),
      onPreview: (row) => setPreview(row),
      onPush: (row, platformKey) => setPush({ platformKey, trackId: row.trackId }),
    }),
    [],
  );

  const subheader = (
    <>
      <SpotifyStatusBanner onReconnect={() => void reconnectSpotify()} status={spotifyStatus} />
      {/* One filter strip, two axes: the pipeline worklist, then — past a divider —
          the mixtape lens (the cassette glyph marks the group; every pill says
          "tape"). Wraps to two lines on a phone. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5">
        {WORKLISTS.map((worklist) => (
          <FilterPill
            active={worklist.key === activeWorklist}
            count={counts(worklist)}
            key={worklist.key}
            label={worklist.label}
            onClick={() => setWorklist(worklist.key)}
          />
        ))}
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <CassetteTapeIcon
          aria-hidden="true"
          className="mr-0.5 size-3.5 text-muted-foreground"
          weight="fill"
        />
        {MIX_FILTERS.map((filter) => (
          <FilterPill
            active={filter.key === activeMix}
            count={mixCounts(filter.key)}
            key={filter.key}
            label={filter.label}
            onClick={() => setMix(filter.key)}
          />
        ))}
      </div>
      {shownError ? (
        <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-5">
          {shownError}
        </p>
      ) : undefined}
    </>
  );

  const headerActions = (
    <>
      {/* Labels collapse to icons under sm so the two actions + badge stop
          squeezing the "Findings" title into an ellipsis on a phone (DIST-02).
          aria-label carries the name when the text is hidden. */}
      <Button aria-label="Submissions" onClick={() => setTrayOpen(true)} size="sm" variant="ghost">
        <TrayIcon aria-hidden="true" weight={submissions.length > 0 ? "fill" : "regular"} />
        <span className="hidden sm:inline">Submissions</span>
        {submissions.length > 0 ? (
          <Badge className="tabular-nums" variant="secondary">
            {submissions.length}
          </Badge>
        ) : undefined}
      </Button>
      <Button aria-label="Add finding" onClick={() => setAddOpen(true)} size="sm">
        <PlusIcon aria-hidden="true" weight="bold" />
        <span className="hidden sm:inline">Add finding</span>
      </Button>
    </>
  );

  return (
    <AdminShell headerActions={headerActions} subheader={subheader} title="Findings">
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No findings yet</EmptyTitle>
            <EmptyDescription>Logged bangers will show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing in this view</EmptyTitle>
            <EmptyDescription>
              No loaded findings match these filters — widen the worklist or the mixtape lens.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <PipelineBoard actions={actions} entries={entries} />
          {hasNextPage ? (
            <div className="border-t border-border p-3 text-center sm:p-4" ref={sentinelRef}>
              <Button
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                size="sm"
                variant="outline"
              >
                {isFetchingNextPage ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : undefined}
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : undefined}
        </>
      )}

      <AddFindingDialog onAdded={onFindingAdded} onOpenChange={setAddOpen} open={addOpen} />

      <SubmissionsTray
        focusId={focusSubmissionId}
        loading={submissionsFetching}
        onChanged={onSubmissionsChanged}
        onOpenChange={onTrayOpenChange}
        open={trayOpen}
        submissions={submissions}
      />

      <EnrichDialog
        error={enrichError}
        onOpenChange={(open) => !open && setEnrichId(undefined)}
        onTrigger={runEnrichment}
        row={enrichRow ?? null}
        triggering={enrichBusy}
      />

      <NoteDialog
        error={noteError}
        hasNext={noteRow ? nextVisibleTrackId(noteRow.trackId) !== undefined : false}
        onOpenChange={(open) => !open && setNoteId(undefined)}
        onSave={(note) => void saveNote(note)}
        onSaveAndNext={(note) => void saveNote(note, true)}
        row={noteRow ?? null}
        saving={noteSaving}
      />

      <ContextDialog
        contextNote={contextNoteData?.contextNote ?? ""}
        loading={contextFetching}
        onOpenChange={(open) => !open && setContextId(undefined)}
        row={contextRow ?? null}
      />

      <ObservationDialog
        onOpenChange={(open) => !open && setObservationId(undefined)}
        row={observationRow ?? null}
        script={observationScriptData?.script ?? ""}
        scriptLoading={observationScriptFetching}
      />

      <PushDialog
        busy={(status) =>
          push ? Boolean(busy[`${push.trackId}:${push.platformKey}:${status}`]) : false
        }
        copied={copiedId === pushRow?.trackId}
        onCopyCaption={() => pushRow && copyCaption(pushRow)}
        onMarkFailed={markFailed}
        onMarkLive={markLive}
        onOpenChange={(open) => !open && setPush(undefined)}
        onPush={onPush}
        platform={pushPlatform}
        pushing={push ? Boolean(busy[`${push.trackId}:${push.platformKey}:draft`]) : false}
        row={pushRow ?? null}
        tiktokPending={tiktokPending}
      />

      {/* Single-clip preview — the same Stories UI as /log/<id>, one post (no
          swipe). Loads the clip only on open; handy for lining up the TikTok sound. */}
      <Dialog onOpenChange={(open) => !open && setPreview(undefined)} open={preview !== undefined}>
        <DialogContent
          aria-label="Clip preview"
          className="inset-0 top-0 left-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 ring-0 sm:max-w-none"
          showCloseButton={false}
        >
          {preview ? (
            <StoriesPlayer
              initialLogId={preview.logId ?? undefined}
              onClose={() => setPreview(undefined)}
              onStoryChange={() => {}}
              presentation="dialog"
              tracks={[preview]}
            />
          ) : undefined}
        </DialogContent>
      </Dialog>

      <AddToPlanDialog
        memberships={mixtapeRow?.mixtapes ?? []}
        onAdded={onAddedToPlan}
        onOpenChange={(open) => !open && setMixtapeId(undefined)}
        planMemberships={mixtapeRow?.plans ?? []}
        plans={planTargets}
        plansLoading={plansFetching && planTargets.length === 0}
        track={mixtapeRow ?? null}
      />
    </AdminShell>
  );
}

// The Spotify connection banner — shown only when there's something to act on:
// disconnected (the stored authorization is gone, so search + publishing are
// paused) or stale (still working, but old enough to reconnect before the
// six-month expiry). A quiet strip under the header with one Reconnect action.
function SpotifyStatusBanner({
  onReconnect,
  status,
}: {
  onReconnect: () => void;
  status?: SpotifyAuthStatus;
}) {
  if (!status || (status.connected && !status.stale)) {
    return null;
  }

  const disconnected = !status.connected;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm sm:px-5",
        disconnected
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      <span>
        {disconnected
          ? "Spotify isn’t connected — search and publishing are paused until you reconnect."
          : `Spotify authorization is ${status.ageDays} days old and will expire — reconnect to avoid disruption.`}
      </span>
      <Button onClick={onReconnect} size="sm" variant={disconnected ? "destructive" : "secondary"}>
        Reconnect Spotify
      </Button>
    </div>
  );
}

// One filter pill — a worklist or mixtape lens, with its live count. Shared by both
// groups in the filter strip so they read identically.
function FilterPill({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} size="sm" variant={active ? "secondary" : "ghost"}>
      {label}
      <Badge
        className={cn(
          "ml-1 tabular-nums",
          active ? "border-primary/40 bg-primary/10 text-primary" : "",
        )}
        variant={active ? "outline" : "secondary"}
      >
        {count}
      </Badge>
    </Button>
  );
}
