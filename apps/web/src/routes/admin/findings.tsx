import { CassetteTapeIcon, CircleNotchIcon, PlusIcon, TrayIcon } from "@phosphor-icons/react";
import { formatError, isStaleTikTokDraft } from "@fluncle/contracts/util";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureAdmin } from "@/lib/admin-guard";
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
import { CaptureSourceDialog, useCaptureSource } from "@/components/admin/capture-source-dialog";
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
import { Label } from "@fluncle/ui/components/label";
import { Switch } from "@fluncle/ui/components/switch";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { readCaptions } from "@/lib/server/captions";
import { captionForPlatform } from "@/lib/server/mentions";
import { listMixtapeMembershipsForTracks } from "@/lib/server/mixtapes";
import {
  getContextNote,
  getObservationScript,
  listFindingBoardFlagsForTracks,
} from "@/lib/server/observation-board";
import {
  getRecordingCues,
  listPlanMembershipsForTracks,
  listRecordings,
} from "@/lib/server/recordings";
import { isPublishAdvancePaused } from "@/lib/server/publish-advance";
import { listSocialPostsForTracks } from "@/lib/server/social";
import { getSpotifyAuthStatus, type SpotifyAuthStatus } from "@/lib/server/spotify";
import { listPendingSubmissions, type Submission } from "@/lib/server/submissions";
import { type BlockedOn, trackStage } from "@/lib/track-stage";
import {
  type CaptureSourceState,
  decodeTrackCursor,
  getCaptureSourceState,
  getTrackByIdOrLogId,
  hasTrackFeatures,
  listEmbeddingPresenceForTracks,
  listTracks,
} from "@/lib/server/tracks";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

const BOARD_MAX_PAGES = 5;

const BOARD_STALE_MS = 20_000;

const BOARD_KEY = ["admin", "posts", "board"] as const;

const SPOTIFY_STATUS_KEY = ["admin", "spotify", "status"] as const;

const SUBMISSIONS_KEY = ["admin", "submissions"] as const;

const BOARD_ROW_KEY = ["admin", "board-row"] as const;

const PLAN_TARGETS_KEY = ["admin", "plans", "targets"] as const;

const CONTEXT_NOTE_KEY = ["admin", "context-note"] as const;

const OBSERVATION_SCRIPT_KEY = ["admin", "observation-script"] as const;

const ENRICH_FEATURES_KEY = ["admin", "enrich-features"] as const;

const CAPTURE_SOURCE_KEY = ["admin", "capture-source"] as const;

type Worklist = "all" | "needs-tagging" | "needs-video" | "ready-youtube" | "ready-tiktok" | "done";

type WorklistDef = { blockedOn?: BlockedOn; key: Worklist; label: string };

const ALL_WORKLIST: WorklistDef = { key: "all", label: "All" };
const WORKLISTS: WorklistDef[] = [ALL_WORKLIST, { blockedOn: null, key: "done", label: "Live" }];

const WORKLIST_KEYS = new Set(WORKLISTS.map((worklist) => worklist.key));

type MixState = "open" | "plan" | "tape";
type MixFilter = "all" | MixState;

const MIX_FILTERS: { key: MixFilter; label: string }[] = [
  { key: "all", label: "Any tape" },
  { key: "open", label: "Not on a tape" },
  { key: "plan", label: "In a plan" },
  { key: "tape", label: "On a tape" },
];

const MIX_FILTER_KEYS = new Set(MIX_FILTERS.map((filter) => filter.key));

function mixtapeStateOf(row: BoardRow): MixState {
  if (row.mixtapes.length > 0) {
    return "tape";
  }
  return row.plans.length > 0 ? "plan" : "open";
}

function matchesMixFilter(row: BoardRow, activeMix: MixFilter): boolean {
  return activeMix === "all" || mixtapeStateOf(row) === activeMix;
}

function matchesWorklistFilter(blockedOn: BlockedOn, worklist: WorklistDef): boolean {
  return worklist.key === "all" || blockedOn === worklist.blockedOn;
}

const fetchBoard = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string }) => data)
  .handler(async ({ data }): Promise<BoardPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const page = await listTracks({
      board: true,
      countTotal: false,
      cursor: decodeTrackCursor(data.cursor ?? null),
      limit: PAGE_SIZE,
      order: "desc",
    });
    const trackIds = page.tracks.map((track) => track.trackId);

    const [posts, mixtapes, plans, embeddings, flags] = await Promise.all([
      listSocialPostsForTracks(trackIds),
      listMixtapeMembershipsForTracks(trackIds),
      listPlanMembershipsForTracks(trackIds),
      listEmbeddingPresenceForTracks(trackIds),
      listFindingBoardFlagsForTracks(trackIds),
    ]);

    return {
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
      tracks: page.tracks.map((track) => {
        const trackFlags = flags.get(track.trackId);

        return {
          ...track,
          discogsRan: trackFlags?.discogsRan ?? false,
          hasContextNote: trackFlags?.hasContextNote ?? false,
          hasEmbedding: embeddings.has(track.trackId),
          lastfmLoved: trackFlags?.lastfmLoved ?? false,
          lastfmRan: trackFlags?.lastfmRan ?? false,
          mixtapes: mixtapes[track.trackId] ?? [],
          noteRan: trackFlags?.noteRan ?? false,
          plans: plans[track.trackId] ?? [],
          posts: posts[track.trackId] ?? [],
        };
      }),
    };
  });

const fetchBoardRow = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<BoardRow | null> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const track = await getTrackByIdOrLogId(data.trackId);

    if (!track) {
      return null;
    }

    const ids = [track.trackId];
    const [posts, mixtapes, plans, embeddings, flags] = await Promise.all([
      listSocialPostsForTracks(ids),
      listMixtapeMembershipsForTracks(ids),
      listPlanMembershipsForTracks(ids),
      listEmbeddingPresenceForTracks(ids),
      listFindingBoardFlagsForTracks(ids),
    ]);
    const trackFlags = flags.get(track.trackId);

    return {
      ...track,
      discogsRan: trackFlags?.discogsRan ?? false,
      hasContextNote: trackFlags?.hasContextNote ?? false,
      hasEmbedding: embeddings.has(track.trackId),
      lastfmLoved: trackFlags?.lastfmLoved ?? false,
      lastfmRan: trackFlags?.lastfmRan ?? false,
      mixtapes: mixtapes[track.trackId] ?? [],
      noteRan: trackFlags?.noteRan ?? false,
      plans: plans[track.trackId] ?? [],
      posts: posts[track.trackId] ?? [],
    };
  });

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

const fetchCaption = createServerFn({ method: "GET" })
  .validator((data: { logId: string; trackId?: string }) => data)
  .handler(async ({ data }): Promise<{ caption: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const captions = await readCaptions([data.logId]);
    const raw = captions[data.logId] ?? "";

    return { caption: await captionForPlatform(data.trackId ?? "", "tiktok", raw) };
  });

const fetchContextNote = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<{ contextNote: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { contextNote: await getContextNote(data.trackId) };
  });

const fetchObservationScript = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<{ script: string }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { script: await getObservationScript(data.trackId) };
  });

const fetchEnrichFeatures = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<{ hasFeatures: boolean }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { hasFeatures: await hasTrackFeatures(data.trackId) };
  });

const fetchCaptureSource = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data }): Promise<CaptureSourceState | null> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return getCaptureSourceState(data.trackId);
  });

const fetchSpotifyStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SpotifyAuthStatus> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return getSpotifyAuthStatus();
  },
);

const fetchSubmissions = createServerFn({ method: "GET" }).handler(
  async (): Promise<Submission[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listPendingSubmissions();
  },
);

const fetchPublishAdvance = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ paused: boolean }> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return { paused: await isPublishAdvancePaused() };
  },
);

type BoardSearch = {
  mix: MixFilter;
  note?: string;
  observation?: string;
  stage: Worklist;
  submission?: string;
};

const ADVANCE_KEY = ["admin", "publish-advance"] as const;

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

    ...(typeof search.note === "string" ? { note: search.note } : {}),

    ...(typeof search.observation === "string" ? { observation: search.observation } : {}),

    ...(typeof search.submission === "string" ? { submission: search.submission } : {}),
  }),
  beforeLoad: async () => {
    await ensureAdmin();
  },
  loader: async () => {
    const [board, advance] = await Promise.all([fetchBoard({ data: {} }), fetchPublishAdvance()]);
    return { advance, board };
  },
  component: AdminBoardPage,
});

function BoardContent({
  actions,
  entries,
  hasNextPage,
  isFetchingNextPage,
  onFetchNext,
  onToggleAdvance,
  paused,
  pendingAdvance,
  rows,
  sentinelRef,
  visible,
}: {
  actions: BoardActions;
  entries: BoardEntry[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNext: () => void;
  onToggleAdvance: (paused: boolean) => void;
  paused: boolean;
  pendingAdvance: boolean;
  rows: BoardRow[];
  sentinelRef: { current: HTMLDivElement | null };
  visible: unknown[];
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No findings yet</EmptyTitle>
          <EmptyDescription>Logged bangers will show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (visible.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing in this view</EmptyTitle>
          <EmptyDescription>
            No loaded findings match these filters — widen the worklist or the mixtape lens.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <div className="border-b border-border p-3 sm:p-4">
        <AutoPublishSwitch onToggle={onToggleAdvance} paused={paused} pending={pendingAdvance} />
      </div>
      <PipelineBoard actions={actions} entries={entries} />
      {hasNextPage ? (
        <div className="border-t border-border p-3 text-center sm:p-4" ref={sentinelRef}>
          <Button disabled={isFetchingNextPage} onClick={onFetchNext} size="sm" variant="outline">
            {isFetchingNextPage ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : undefined}
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : undefined}
    </>
  );
}

function queryErrorMessage(queryError: unknown): string | undefined {
  return queryError ? formatError(queryError) : undefined;
}

function platformForPush(push: { platformKey: string } | undefined) {
  return push ? (PLATFORMS.find((platform) => platform.key === push.platformKey) ?? null) : null;
}

function firstBoardRow(...rows: Array<BoardRow | null | undefined>): BoardRow | undefined {
  return rows.find((row): row is BoardRow => row !== null && row !== undefined);
}

function selectedPushTrackId(
  push: { platformKey: string; trackId: string } | undefined,
): string | undefined {
  return push?.trackId;
}

function boardError(publishError: string | undefined, loadError: string | undefined) {
  return publishError ?? loadError;
}

function AdminBoardPage() {
  const { advance: initialAdvance, board: initial } = Route.useLoaderData();
  const {
    mix: activeMix,
    note: focusNoteTrackId,
    observation: focusObservationTrackId,
    stage: activeWorklist,
    submission: focusSubmissionId,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

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
    maxPages: BOARD_MAX_PAGES,
    queryFn: ({ pageParam }) => fetchBoard({ data: { cursor: pageParam } }),
    queryKey: BOARD_KEY,
    refetchOnWindowFocus: true,
    staleTime: BOARD_STALE_MS,
  });

  const rows = useMemo(() => data?.pages.flatMap((page) => page.tracks) ?? [], [data]);

  const { busy, error, pushDraft, setError, setStatus } = usePublish(BOARD_KEY);

  const { data: advance } = useQuery({
    initialData: initialAdvance,
    queryFn: () => fetchPublishAdvance(),
    queryKey: ADVANCE_KEY,
    refetchOnWindowFocus: true,
  });

  const setAdvancePaused = useMutation<void, Error, boolean, { previous?: { paused: boolean } }>({
    mutationFn: async (paused: boolean) => {
      const response = await fetch("/api/v1/admin/social/publish/advance/state", {
        body: JSON.stringify({ paused }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Flip failed (${response.status})`);
      }
    },
    onError: (caught, _paused, context) => {
      if (context?.previous) {
        queryClient.setQueryData(ADVANCE_KEY, context.previous);
      }

      setError(caught.message);
    },
    onMutate: async (paused) => {
      await queryClient.cancelQueries({ queryKey: ADVANCE_KEY });
      const previous = queryClient.getQueryData<{ paused: boolean }>(ADVANCE_KEY);
      queryClient.setQueryData(ADVANCE_KEY, { paused });

      return { previous };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ADVANCE_KEY }),
  });

  const [enrichId, setEnrichId] = useState<string | undefined>();
  const [push, setPush] = useState<{ platformKey: string; trackId: string } | undefined>();
  const [preview, setPreview] = useState<BoardRow | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichError, setEnrichError] = useState<string | undefined>();

  const [captureSourceId, setCaptureSourceId] = useState<string | undefined>();

  const [noteId, setNoteId] = useState<string | undefined>(() => focusNoteTrackId);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | undefined>();

  const [contextId, setContextId] = useState<string | undefined>();

  const [observationId, setObservationId] = useState<string | undefined>(
    () => focusObservationTrackId,
  );

  const [addOpen, setAddOpen] = useState(false);

  const [trayOpen, setTrayOpen] = useState(() => focusSubmissionId !== undefined);

  useEffect(() => {
    if (focusSubmissionId !== undefined) {
      setTrayOpen(true);
    }
  }, [focusSubmissionId]);

  useEffect(() => {
    if (focusNoteTrackId !== undefined) {
      setNoteId(focusNoteTrackId);
    }
  }, [focusNoteTrackId]);

  useEffect(() => {
    if (focusObservationTrackId !== undefined) {
      setObservationId(focusObservationTrackId);
    }
  }, [focusObservationTrackId]);

  const onNoteOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return;
      }

      setNoteId(undefined);

      if (focusNoteTrackId !== undefined) {
        void navigate({ search: (previous) => ({ ...previous, note: undefined }) });
      }
    },
    [focusNoteTrackId, navigate],
  );

  const onObservationOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return;
      }

      setObservationId(undefined);

      if (focusObservationTrackId !== undefined) {
        void navigate({ search: (previous) => ({ ...previous, observation: undefined }) });
      }
    },
    [focusObservationTrackId, navigate],
  );

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

  const onSubmissionsChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SUBMISSIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY });
  }, [queryClient]);

  const rowFor = useCallback(
    (trackId?: string) => (trackId ? rows.find((row) => row.trackId === trackId) : undefined),
    [rows],
  );
  const enrichRow = rowFor(enrichId);
  const captureSourceRow = rowFor(captureSourceId);
  const boardNoteRow = rowFor(noteId);

  const { data: fetchedNoteRow } = useQuery({
    enabled: noteId !== undefined && boardNoteRow === undefined,
    queryFn: () => fetchBoardRow({ data: { trackId: noteId as string } }),
    queryKey: [...BOARD_ROW_KEY, noteId],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const noteRow = firstBoardRow(boardNoteRow, fetchedNoteRow);
  const contextRow = rowFor(contextId);
  const observationRow = rowFor(observationId);
  const pushRow = rowFor(selectedPushTrackId(push));
  const pushPlatform = platformForPush(push);

  const loadError = queryErrorMessage(queryError);
  const shownError = boardError(error, loadError);

  const staged = useMemo(() => rows.map((row) => ({ ...trackStage(row), row })), [rows]);

  const worklistDef = WORKLISTS.find((worklist) => worklist.key === activeWorklist) ?? ALL_WORKLIST;

  const visible = useMemo(
    () =>
      staged.filter(
        (entry) =>
          matchesWorklistFilter(entry.blockedOn, worklistDef) &&
          matchesMixFilter(entry.row, activeMix),
      ),
    [activeMix, staged, worklistDef],
  );

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

  const byMix = useMemo(
    () => staged.filter((entry) => matchesMixFilter(entry.row, activeMix)),
    [activeMix, staged],
  );
  const byWorklist = useMemo(
    () => staged.filter((entry) => matchesWorklistFilter(entry.blockedOn, worklistDef)),
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

  const [mixtapeId, setMixtapeId] = useState<string | undefined>();
  const mixtapeRow = rowFor(mixtapeId);

  const { data: planTargets = [], isFetching: plansFetching } = useQuery({
    enabled: mixtapeId !== undefined,
    queryFn: fetchPlanTargets,
    queryKey: PLAN_TARGETS_KEY,
    refetchOnWindowFocus: true,
  });

  const onAddedToPlan = useCallback(() => {
    setMixtapeId(undefined);
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY });
    void queryClient.invalidateQueries({ queryKey: PLAN_TARGETS_KEY });
  }, [queryClient]);

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

  const copyCaption = useCallback(
    (row: BoardRow) => {
      if (!row.logId) {
        return;
      }

      setError(undefined);
      const text = fetchCaption({ data: { logId: row.logId, trackId: row.trackId } }).then(
        ({ caption }) =>
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

  const { data: spotifyStatus } = useQuery({
    queryFn: fetchSpotifyStatus,
    queryKey: SPOTIFY_STATUS_KEY,
    refetchOnWindowFocus: true,
  });

  const reconnectSpotify = useCallback(async () => {
    setError(undefined);

    try {
      const response = await fetch("/api/v1/admin/spotify/auth/start", {
        credentials: "same-origin",
      });
      const data = (await response.json()) as { authUrl?: string };

      if (!response.ok || !data.authUrl) {
        throw new Error("Couldn't start the Spotify reconnect.");
      }

      window.location.href = data.authUrl;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [setError]);

  const { data: contextNoteData, isFetching: contextFetching } = useQuery({
    enabled: contextId !== undefined,
    queryFn: () => fetchContextNote({ data: { trackId: contextId as string } }),
    queryKey: [...CONTEXT_NOTE_KEY, contextId],
    staleTime: Number.POSITIVE_INFINITY,
  });

  const { data: observationScriptData, isFetching: observationScriptFetching } = useQuery({
    enabled: observationId !== undefined,
    queryFn: () => fetchObservationScript({ data: { trackId: observationId as string } }),
    queryKey: [...OBSERVATION_SCRIPT_KEY, observationId],
    staleTime: Number.POSITIVE_INFINITY,
  });

  const { data: enrichFeaturesData } = useQuery({
    enabled: enrichId !== undefined,
    queryFn: () => fetchEnrichFeatures({ data: { trackId: enrichId as string } }),
    queryKey: [...ENRICH_FEATURES_KEY, enrichId],
    staleTime: Number.POSITIVE_INFINITY,
  });

  const captureSource = useCaptureSource({
    fetchState: (trackId) => fetchCaptureSource({ data: { trackId } }),
    onClose: () => setCaptureSourceId(undefined),
    queryKey: CAPTURE_SOURCE_KEY,
    row: captureSourceRow,
    trackId: captureSourceId,
  });

  const nextVisibleTrackId = useCallback(
    (currentTrackId: string): string | undefined => {
      const index = visible.findIndex((entry) => entry.row.trackId === currentTrackId);
      return index >= 0 && index + 1 < visible.length ? visible[index + 1]?.row.trackId : undefined;
    },
    [visible],
  );

  const saveNote = useCallback(
    async (note: string, advance?: boolean) => {
      if (!noteRow) {
        return;
      }

      setNoteSaving(true);
      setNoteError(undefined);

      try {
        const response = await fetch(`/api/v1/admin/tracks/${noteRow.trackId}`, {
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
      const response = await fetch(`/api/v1/admin/tracks/${enrichRow.trackId}`, {
        body: JSON.stringify({ enrichmentStatus: "pending" }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        throw new Error(`Queue failed (${response.status})`);
      }

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

  const actions = useMemo<BoardActions>(
    () => ({
      onCaptureSource: (row) => setCaptureSourceId(row.trackId),
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
      <BoardContent
        actions={actions}
        entries={entries}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onFetchNext={() => void fetchNextPage()}
        onToggleAdvance={(paused) => setAdvancePaused.mutate(paused)}
        paused={advance.paused}
        pendingAdvance={setAdvancePaused.isPending}
        rows={rows}
        sentinelRef={sentinelRef}
        visible={visible}
      />

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
        hasFeatures={enrichFeaturesData?.hasFeatures ?? false}
        onOpenChange={(open) => !open && setEnrichId(undefined)}
        onTrigger={runEnrichment}
        row={enrichRow ?? null}
        triggering={enrichBusy}
      />

      <CaptureSourceDialog
        busy={captureSource.busy}
        error={captureSource.error}
        loading={captureSource.loading}
        onClear={captureSource.clear}
        onOpenChange={captureSource.onOpenChange}
        onPin={captureSource.pin}
        row={captureSource.row}
        state={captureSource.state}
      />

      <NoteDialog
        error={noteError}
        hasNext={noteRow ? nextVisibleTrackId(noteRow.trackId) !== undefined : false}
        onOpenChange={onNoteOpenChange}
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
        onOpenChange={onObservationOpenChange}
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

function AutoPublishSwitch({
  onToggle,
  paused,
  pending,
}: {
  onToggle: (paused: boolean) => void;
  paused: boolean;
  pending: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
      <Switch
        aria-label="Auto-publish a finding once it is rendered"
        checked={!paused}
        disabled={pending}
        id="publish-advance-switch"
        onCheckedChange={(next) => onToggle(!next)}
      />
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor="publish-advance-switch">Auto-publish rendered findings</Label>
        <p className="text-sm text-muted-foreground">
          {paused
            ? "Paused. A rendered finding waits here for your push."
            : "Live. A rendered finding goes out on its own — the Short posts, the TikTok draft lands in the app for you to finish."}
        </p>
      </div>
    </div>
  );
}
