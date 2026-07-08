import { FilmSlateIcon } from "@phosphor-icons/react";
import { type ClipDTO, type RecordingDTO } from "@fluncle/contracts/orpc";
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { UploadRecordingDialog } from "@/components/admin/upload-recording-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listClips } from "@/lib/server/clips";
import { listRecordings } from "@/lib/server/recordings";

// The recordings index — every captured set (a RECORDING), promoted or not, and the one
// primary action that stages a new one (Upload recording, top-right in the header). A
// captured set is uploaded here, then each row links to its Studio
// (/admin/studio/$recordingId) — the per-set clipping workstation. The cross-recording
// clip LIBRARY + the Instagram drip kill-switch live on the sibling Clips page; this page
// is purely "find + open a set to clip it" plus the uploader (ADM-03 — the Studio group
// split Recordings out of Clips).
//
// Each row carries a promoted badge (`fluncle://<logId>` once a take is promoted to a
// mixtape) and its clip count, so the operator can see at a glance which sets have been
// worked. A recording with no clips still appears — that's the point (open it to cut the
// first clip). Reads `list_recordings` + `list_clips` (the latter only for the per-recording
// clip counts), both SERVER-SIDE in-process (a createServerFn calling the server helpers) —
// not a cross-origin client fetch.

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every recording (the index rows + the count denominators).
const fetchRecordings = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecordingDTO[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listRecordings();
  },
);

// Every clip — used only to count how many clips each recording has yielded (the per-row
// tally). The clip library itself lives on the Clips page.
const fetchAllClips = createServerFn({ method: "GET" }).handler(async (): Promise<ClipDTO[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listClips();
});

export const Route = createFileRoute("/admin/recordings")({
  beforeLoad: () => ensureAdmin(),
  component: RecordingsPage,
  loader: async () => ({
    clips: await fetchAllClips(),
    recordings: await fetchRecordings(),
  }),
});

function RecordingsPage() {
  const { clips: initialClips, recordings: initialRecordings } = Route.useLoaderData();
  const queryClient = useQueryClient();

  // The recordings index, seeded from the loader and refetched on focus — so a
  // browser-uploaded recording lands here without a reload (the header "Upload recording"
  // action invalidates this key on success).
  const { data: recordings } = useQuery<RecordingDTO[]>({
    initialData: initialRecordings,
    queryFn: () => fetchRecordings(),
    queryKey: ["admin", "recordings"],
    refetchOnWindowFocus: true,
  });

  const { data: clips } = useQuery<ClipDTO[]>({
    initialData: initialClips,
    queryFn: () => fetchAllClips(),
    queryKey: ["admin", "clips"],
    refetchOnWindowFocus: true,
  });

  // The clip count per recording, over ALL clips — a stable map of the backlog.
  const clipCountByRecording = useMemo(() => {
    const counts = new Map<string, number>();

    for (const clip of clips) {
      if (clip.recordingId) {
        counts.set(clip.recordingId, (counts.get(clip.recordingId) ?? 0) + 1);
      }
    }

    return counts;
  }, [clips]);

  return (
    <AdminShell
      headerActions={
        <UploadRecordingDialog
          onUploaded={() =>
            void queryClient.invalidateQueries({ queryKey: ["admin", "recordings"] })
          }
        />
      }
      subtitle={`${recordings.length} ${recordings.length === 1 ? "recording" : "recordings"}`}
      title="Recordings"
    >
      <div className="p-4 sm:p-5">
        <RecordingsIndex clipCountByRecording={clipCountByRecording} recordings={recordings} />
      </div>
    </AdminShell>
  );
}

// The recordings index: every captured set with its title, clip count, and a promoted
// badge, each linking to its Studio. A recording with no clips still appears — that's the
// point (open it to cut the first clip).
function RecordingsIndex({
  clipCountByRecording,
  recordings,
}: {
  clipCountByRecording: Map<string, number>;
  recordings: RecordingDTO[];
}) {
  if (recordings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <FilmSlateIcon aria-hidden="true" className="size-7 text-muted-foreground/70" />
        <p className="font-medium">No recordings yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Hit <span className="font-medium text-foreground">Upload recording</span> up top to stage
          a captured set, then open it here to clip it.
        </p>
      </div>
    );
  }

  return (
    <ObjectList>
      {recordings.map((rec) => {
        const clipCount = clipCountByRecording.get(rec.id) ?? 0;

        return (
          <ObjectRow
            key={rec.id}
            trailing={
              <>
                {rec.logId ? (
                  <Badge variant="default">promoted · fluncle://{rec.logId}</Badge>
                ) : (
                  <Badge variant="outline">recording</Badge>
                )}
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {clipCount} clip{clipCount === 1 ? "" : "s"}
                </span>
              </>
            }
          >
            <ObjectLead
              leading={<ObjectGlyph icon={FilmSlateIcon} />}
              title={rec.logId ? rec.title.split(" | ")[0] : rec.title}
              titleHref={`/admin/studio/${encodeURIComponent(rec.id)}`}
            />
          </ObjectRow>
        );
      })}
    </ObjectList>
  );
}
