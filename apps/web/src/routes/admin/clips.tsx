import { FilmStripIcon } from "@phosphor-icons/react";
import { type ClipDTO } from "@fluncle/contracts/orpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { ClipCard } from "@/components/admin/clip-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type MixtapeDTO, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listClips } from "@/lib/server/clips";
import { listMixtapes } from "@/lib/server/mixtapes";
import {
  ALL_FILTER,
  type ClipStatusFilter,
  DEFAULT_CLIP_FILTER,
  filterClips,
} from "@/lib/studio-clips";

// Unit G — the cross-mixtape clip library (docs/fluncle-studio-rfc.md §8). A set yields
// MANY clips, so beyond the per-set editor (/admin/studio/$mixtapeId, Unit E) this is
// the grid of EVERY clip across every set: browse, filter (by set + status), preview
// inline, and DOWNLOAD one to hand-post (the irreducible in-app beat). Reads `list_clips`
// (Unit D); `delete_clip` prunes a bad cut. Distribution is deferred — the card carries
// a disabled seam where push-to-social lands later.
//
// The grid + the set dropdown load SERVER-SIDE (a createServerFn calling the server
// helpers in-process, the same pattern the editor uses) — not a cross-origin client
// fetch. Filtering then runs client-side over the loaded set (the backlog is small;
// instant, no refetch per dropdown change).

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every clip, newest-first (the library reads the whole set; the per-mixtape narrowing
// is a client-side filter). Server-side: in-process, no HTTP, no CORS.
const fetchAllClips = createServerFn({ method: "GET" }).handler(async (): Promise<ClipDTO[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listClips();
});

// The sets (incl. drafts) the set dropdown labels itself from, and the cards link back
// to. Static for the page's life — loaded once.
const fetchClipMixtapes = createServerFn({ method: "GET" }).handler(
  async (): Promise<MixtapeDTO[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listMixtapes({ includeDrafts: true });
  },
);

export const Route = createFileRoute("/admin/clips")({
  beforeLoad: () => ensureAdmin(),
  component: ClipLibraryPage,
  loader: async () => ({
    clips: await fetchAllClips(),
    mixtapes: await fetchClipMixtapes(),
  }),
});

function ClipLibraryPage() {
  const { clips: initialClips, mixtapes } = Route.useLoaderData();
  const queryClient = useQueryClient();

  // Seeded from the SSR loader (the web's react-query convention), so the first paint
  // is the server grid; a delete invalidates + refetches via the same server fn.
  const { data: clips } = useQuery<ClipDTO[]>({
    initialData: initialClips,
    queryFn: () => fetchAllClips(),
    queryKey: ["admin", "clips"],
    refetchOnWindowFocus: true,
  });

  const [mixtapeId, setMixtapeId] = useState<string>(DEFAULT_CLIP_FILTER.mixtapeId);
  const [status, setStatus] = useState<ClipStatusFilter>(DEFAULT_CLIP_FILTER.status);
  const [error, setError] = useAutoNotice();
  const [notice, setNotice] = useAutoNotice();

  const mixtapeById = useMemo(
    () => new Map(mixtapes.filter((m) => m.id).map((m) => [m.id, m] as const)),
    [mixtapes],
  );

  // The set dropdown only offers sets that actually yielded a clip — no empty options.
  const setsWithClips = useMemo(() => {
    const ids = new Set(clips.map((clip) => clip.mixtapeId));

    return mixtapes.filter((m) => m.id && ids.has(m.id));
  }, [clips, mixtapes]);

  // If the active set filter no longer has clips (its last clip was deleted), fall back
  // to "all" so the grid never strands the operator on an empty filtered view.
  useEffect(() => {
    if (mixtapeId !== ALL_FILTER && !setsWithClips.some((m) => m.id === mixtapeId)) {
      setMixtapeId(ALL_FILTER);
    }
  }, [mixtapeId, setsWithClips]);

  const visible = useMemo(
    () => filterClips(clips, { mixtapeId, status }),
    [clips, mixtapeId, status],
  );

  const deleteClip = useMutation({
    mutationFn: async (clipId: string) => {
      const response = await fetch(`/api/admin/clips/${encodeURIComponent(clipId)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: async () => {
      setNotice("Clip removed.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "clips"] });
    },
  });

  const setItems = useMemo(
    () => ({
      [ALL_FILTER]: "All sets",
      ...Object.fromEntries(
        setsWithClips.map((m) => [m.id, mixtapeDisplayTitle(m.title)] as const),
      ),
    }),
    [setsWithClips],
  );

  const statusItems = { all: "Any state", done: "Ready", pending: "Cutting" } as const;

  return (
    <AdminShell
      current="mixtapes"
      subtitle={`${clips.length} ${clips.length === 1 ? "clip" : "clips"} across every set`}
      title="Clip library"
    >
      <div className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="clip-set-filter">Set</Label>
            <Select
              items={setItems}
              onValueChange={(value) => setMixtapeId(value as string)}
              value={mixtapeId}
            >
              <SelectTrigger
                aria-label="Filter by set"
                className="w-52"
                id="clip-set-filter"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>All sets</SelectItem>
                {setsWithClips.map((m) => (
                  <SelectItem key={m.id} value={m.id ?? ""}>
                    {mixtapeDisplayTitle(m.title)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="clip-status-filter">State</Label>
            <Select
              items={statusItems}
              onValueChange={(value) => setStatus(value as ClipStatusFilter)}
              value={status}
            >
              <SelectTrigger
                aria-label="Filter by state"
                className="w-36"
                id="clip-status-filter"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any state</SelectItem>
                <SelectItem value="done">Ready</SelectItem>
                <SelectItem value="pending">Cutting</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error ? (
          <p className="mb-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p aria-live="polite" className="mb-3 text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        {clips.length === 0 ? (
          <EmptyLibrary />
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No clips match this filter.
          </p>
        ) : (
          <ul className="grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((clip) => (
              <li key={clip.id}>
                <ClipCard
                  clip={clip}
                  deleting={deleteClip.isPending && deleteClip.variables === clip.id}
                  mixtape={mixtapeById.get(clip.mixtapeId)}
                  onDelete={() => deleteClip.mutate(clip.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminShell>
  );
}

function EmptyLibrary() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <FilmStripIcon aria-hidden="true" className="size-7 text-muted-foreground/70" />
      <p className="font-medium">No clips yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Open a set in the Studio and cut a few framed 9:16 clips. They land here, ready to
        hand-post.
      </p>
      <Button nativeButton={false} render={<a href="/admin/mixtapes" />} variant="outline">
        Go to mixtapes
      </Button>
    </div>
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }

  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || `Request failed (${response.status})`;
}

// A transient notice that clears itself after 5s (the editor's pattern).
function useAutoNotice(): readonly [
  string | undefined,
  Dispatch<SetStateAction<string | undefined>>,
] {
  const [value, setValue] = useState<string>();

  useEffect(() => {
    if (!value) {
      return;
    }

    const timer = window.setTimeout(() => setValue(undefined), 5000);

    return () => window.clearTimeout(timer);
  }, [value]);

  return [value, setValue] as const;
}
