import {
  ArrowsSplitIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlanetIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type FormEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { AdminShell } from "@/components/admin/admin-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fluncle/ui/components/alert-dialog";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Input } from "@fluncle/ui/components/input";
import { MixPreviewBar } from "@/components/mix/mix-preview-bar";
import { TrackArtwork } from "@/components/track-artwork";
import { partitionGalaxyBoard } from "@/lib/galaxy-board";
import { useKeyNotation } from "@/lib/key-notation";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { usePreviewControls } from "@/lib/preview-player";
import { findingsCount } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type GalaxyAdminWithMembers,
  listGalaxiesAdminWithMembers,
} from "@/lib/server/galaxies-map";
import { cn } from "@/lib/utils";

// The `/admin/galaxies` NAMING view (Slice 3, browse-by-feel RFC) — the operator's one
// sitting to turn the machine's sound-derived map into a named one. The nightly
// `fluncle-cluster` cron (Slice 2) fits the k=9 galaxies and mints each a permanent
// machine HANDLE; identity is the machine's, the NAME is the operator's editorial act.
// So this view is a naming queue: each unnamed galaxy shows its handle, its member
// covers (which double as an AUDITION — the shared `/api/preview` relay, so the operator
// can HEAR what the cluster is before naming it), and its coherence evidence. The public
// lens (Slice 4) gates on a fully-named map — the launch gate — so the header carries the
// naming progress (n of N named). Renders honestly BEFORE any galaxies exist (a quiet
// "the map hasn't been fit yet") and AFTER the fit lands (N unnamed galaxies awaiting a
// name). The persona law (docs/admin-shell.md): naming is publish-class, so it rides the
// operator-tier `update_galaxy` op (an agent token 403s) — a machine handle NEVER renders
// publicly.

// How many member covers to show per galaxy — a representative, core-first handful for
// the audition, not the whole cluster (the row's count stays the true total).
const MEMBER_CAP = 24;

const GALAXIES_KEY = ["admin", "galaxies"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchGalaxies = createServerFn({ method: "GET" }).handler(
  async (): Promise<GalaxyAdminWithMembers[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listGalaxiesAdminWithMembers(MEMBER_CAP);
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/galaxies")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchGalaxies(),
  component: AdminGalaxiesPage,
});

function AdminGalaxiesPage() {
  const initial = Route.useLoaderData();
  const { notation } = useKeyNotation();
  const { data: galaxies } = useQuery({
    initialData: initial,
    queryFn: () => fetchGalaxies(),
    queryKey: GALAXIES_KEY,
  });

  const board = useMemo(() => partitionGalaxyBoard(galaxies), [galaxies]);
  // Every member across every shown galaxy — the union the shared preview bar resolves the
  // now-playing finding against (one bar for the whole page, whichever cover is playing).
  const allMembers = useMemo(() => galaxies.flatMap((galaxy) => galaxy.members), [galaxies]);

  const subtitle =
    board.nameableCount === 0
      ? "The map hasn't been fit yet"
      : `${board.namedCount} of ${board.nameableCount} named`;

  return (
    <AdminShell subtitle={subtitle} title="Galaxies">
      <div className="space-y-8 p-4 sm:p-5">
        {galaxies.length === 0 ? (
          <EmptyMap />
        ) : (
          <>
            {board.namingQueue.length > 0 ? (
              <Section
                intro="Unnamed galaxies stay off every public surface. Listen, then give each one a name."
                title={`Awaiting a name · ${board.namingQueue.length}`}
              >
                {board.namingQueue.map((galaxy) => (
                  <GalaxyCard galaxy={galaxy} key={galaxy.id} />
                ))}
              </Section>
            ) : null}

            {board.namedGalaxies.length > 0 ? (
              <Section title="The map">
                {board.namedGalaxies.map((galaxy) => (
                  <GalaxyCard galaxy={galaxy} key={galaxy.id} />
                ))}
              </Section>
            ) : null}

            {board.retiredGalaxies.length > 0 ? (
              <Section title="Retired">
                {board.retiredGalaxies.map((galaxy) => (
                  <GalaxyCard galaxy={galaxy} key={galaxy.id} />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </div>

      {/* The shared /mix now-playing bar, reused verbatim: it portals past the admin
          plate's backdrop-blur to the viewport and shows whichever member cover the
          operator is auditioning. The whole audition rides the one preview singleton, so
          starting a cover stops the last one. */}
      <MixPreviewBar findings={allMembers} notation={notation} />
    </AdminShell>
  );
}

// The pre-fit state: the map is empty because the nightly cluster run hasn't drawn it yet
// (or the archive has too few embedded findings to group). Quiet and honest — no fake rows.
function EmptyMap() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-border bg-card/60 px-6 py-12 text-center">
      <PlanetIcon
        aria-hidden="true"
        className="mx-auto mb-3 size-8 text-muted-foreground"
        weight="thin"
      />
      <p className="text-sm font-medium">The map hasn't been fit yet</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        The nightly cluster run draws the galaxies once enough findings carry an embedding to group.
        They'll land here unnamed, waiting on you.
      </p>
    </div>
  );
}

function Section({
  children,
  intro,
  title,
}: {
  children: ReactNode;
  intro?: string;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-bold">{title}</h2>
        {intro ? <p className="mt-0.5 text-xs text-muted-foreground">{intro}</p> : null}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function GalaxyCard({ galaxy }: { galaxy: GalaxyAdminWithMembers }) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [confirmSplit, setConfirmSplit] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const named = Boolean(galaxy.name && galaxy.slug);
  const retired = Boolean(galaxy.retiredAt);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: GALAXIES_KEY });

  const nameMutation = useMutation({
    mutationFn: (name: string) =>
      patchGalaxy(galaxy.id, { name, slug: slugify(name) || galaxy.handle }),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setError(undefined);
      setRenaming(false);
      void invalidate();
    },
  });

  const splitMutation = useMutation({
    mutationFn: () => patchGalaxy(galaxy.id, { requestSplit: true }),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setError(undefined);
      setConfirmSplit(false);
      void invalidate();
    },
  });

  const busy = nameMutation.isPending || splitMutation.isPending;
  const splitRequested = Boolean(galaxy.splitRequestedAt);
  const editing = !named || renaming;

  return (
    // Neutral border in every state (One Sun: at the launch sitting up to nine unnamed
    // cards share the screen, and a gold edge per card would blow the gold budget — the
    // gold "Name it" button is the one sun each card carries; the "Awaiting a name"
    // section grouping does the rest of the signposting).
    <article
      className={cn("rounded-lg border border-border bg-card/60 p-4", retired && "opacity-70")}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* The identity line. A NAMED galaxy leads with its editorial name (Title
              register — the artist-name treatment); its machine handle sits quiet beneath.
              An UNNAMED one leads with the handle alone, the only identity it has yet. */}
          {named ? (
            <>
              <h3 className="truncate text-base font-extrabold">{galaxy.name}</h3>
              {/* The machine handle keeps the Oxanium coordinate face; the public URL
                  rides plain muted text (Oxanium is for coordinates, not paths). */}
              <p className="truncate text-xs text-muted-foreground">
                <span className="track-log-id">{galaxy.handle}</span> · /galaxies/{galaxy.slug}
              </p>
            </>
          ) : (
            <p className="track-log-id truncate">{galaxy.handle}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {findingsCount(galaxy.memberCount)}
            {galaxy.silhouette !== null ? ` · coherence ${galaxy.silhouette.toFixed(2)}` : ""}
            {retired ? " · retired" : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {named && !renaming ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircleIcon aria-hidden="true" className="size-3.5" weight="fill" />
              Named
            </span>
          ) : null}
          {!retired ? (
            <GalaxyMenu
              busy={busy}
              named={named}
              onRename={() => setRenaming(true)}
              onRequestSplit={() => setConfirmSplit(true)}
              splitRequested={splitRequested}
              title={galaxy.name ?? galaxy.handle}
            />
          ) : null}
        </div>
      </div>

      {/* The audition: the member covers, core-first. Each cover is a play/pause button on
          the shared preview singleton (the /mix machinery), so the operator hears the
          cluster before naming it. */}
      {galaxy.members.length > 0 ? (
        <ul className="mt-3 flex list-none flex-wrap gap-2 p-0">
          {galaxy.members.map((member) =>
            member.logId ? (
              <li key={member.logId}>
                <AuditionCover logId={member.logId} member={member} />
              </li>
            ) : null,
          )}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {retired ? "No members left. This region emptied out." : "No embedded members yet."}
        </p>
      )}

      {editing && !retired ? (
        <NameForm
          busy={nameMutation.isPending}
          initial={galaxy.name ?? ""}
          onCancel={named ? () => setRenaming(false) : undefined}
          onSubmit={(name) => nameMutation.mutate(name)}
          submitLabel={named ? "Save name" : "Name it"}
        />
      ) : null}

      {splitRequested && !retired ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Split requested. The next nightly run splits it and a new galaxy lands here unnamed.
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <SplitConfirm
        busy={splitMutation.isPending}
        onConfirm={() => splitMutation.mutate()}
        onOpenChange={setConfirmSplit}
        open={confirmSplit}
        title={galaxy.name ?? galaxy.handle}
      />
    </article>
  );
}

// One member cover, doubling as the row's audition control (the /mix `PreviewArtwork`
// pattern): the album art with a hover/focus play-pause overlay driven by the shared
// preview singleton, so starting one cover stops the last. `.preview-art` CSS is shared.
function AuditionCover({ logId, member }: { logId: string; member: TrackListItem }) {
  const { activeTrackId, pauseResume, start, status } = usePreviewControls();
  const isCurrent = activeTrackId === logId;
  const isPlaying = isCurrent && (status === "playing" || status === "loading");

  const onClick = useCallback(() => {
    if (isCurrent) {
      pauseResume();
    } else {
      start(logId);
    }
  }, [isCurrent, logId, pauseResume, start]);

  return (
    <span className="preview-art relative block size-12 shrink-0">
      <TrackArtwork
        alt=""
        className="size-12"
        src={spotifyAlbumImageAtSize(member.albumImageUrl, "small")}
      />
      <button
        aria-label={
          isPlaying
            ? `Pause ${member.title}`
            : `Play the preview of ${member.title} by ${member.artists.join(", ")}`
        }
        aria-pressed={isCurrent}
        className="preview-art-btn"
        onClick={onClick}
        type="button"
      >
        {isPlaying ? (
          <PauseIcon aria-hidden="true" className="size-4" weight="fill" />
        ) : (
          <PlayIcon aria-hidden="true" className="size-4" weight="fill" />
        )}
      </button>
    </span>
  );
}

// The name/rename form — the operator's editorial act. The slug is derived from the name
// (slugify), so one field is all the operator touches; the resulting public URL previews
// live beneath it.
function NameForm({
  busy,
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  busy: boolean;
  initial: string;
  onCancel?: () => void;
  onSubmit: (name: string) => void;
  submitLabel: string;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const slug = slugify(trimmed);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <form className="mt-3 border-t border-border/60 pt-3" onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Galaxy name"
          autoComplete="off"
          className="h-8 min-w-56 flex-1"
          onChange={(event) => setValue(event.target.value)}
          placeholder="Name this galaxy…"
          value={value}
        />
        <Button disabled={busy || trimmed === ""} size="sm" type="submit">
          {busy ? (
            <CircleNotchIcon
              aria-hidden="true"
              className="motion-safe:animate-spin"
              weight="bold"
            />
          ) : undefined}
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        ) : null}
      </div>
      {slug ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Public URL: /galaxies/{slug}</p>
      ) : null}
    </form>
  );
}

// The rare per-galaxy acts, off the resting surface (the disclosure law): rename (for a
// named galaxy) and request a split. The split confirm is a CONTROLLED dialog owned by the
// card (the renders.tsx pattern), so the menu item just opens it — no fragile nesting of a
// dialog trigger inside a menu item.
function GalaxyMenu({
  busy,
  named,
  onRename,
  onRequestSplit,
  splitRequested,
  title,
}: {
  busy: boolean;
  named: boolean;
  onRename: () => void;
  onRequestSplit: () => void;
  splitRequested: boolean;
  title: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${title}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        disabled={busy}
      >
        <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {named ? (
          <DropdownMenuItem onClick={onRename}>
            <PencilSimpleIcon aria-hidden="true" className="size-4" />
            Rename
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={splitRequested} onClick={onRequestSplit}>
          <ArrowsSplitIcon aria-hidden="true" className="size-4" />
          {splitRequested ? "Split requested" : "Request split"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The split confirm — a controlled AlertDialog. A split restructures the map on the next
// nightly tick, so it names the consequence before the operator commits (the destructive-
// confirm placement rule, though a split is structural rather than destructive).
function SplitConfirm({
  busy,
  onConfirm,
  onOpenChange,
  open,
  title,
}: {
  busy: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Request a split?</AlertDialogTitle>
          <AlertDialogDescription>{title}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span aria-hidden="true" className="select-none">
              ·
            </span>
            <span>The next nightly run splits this galaxy in two by sound.</span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true" className="select-none">
              ·
            </span>
            <span>
              The bigger half keeps this galaxy; the smaller half lands here unnamed for you to
              name.
            </span>
          </li>
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={onConfirm}>
            Request split
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// The operator-tier `update_galaxy` op (PATCH /admin/galaxies/{id}). Naming is
// publish-class, so this rides the operator carrier; the fetch mirrors the newsletter
// admin's op calls (same-origin credentials implied, JSON body, message-bearing errors).
async function patchGalaxy(
  id: string,
  body: { name?: string; requestSplit?: boolean; slug?: string },
): Promise<void> {
  const response = await fetch(`/api/v1/admin/galaxies/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { message?: unknown };
    if (typeof data.message === "string" && data.message.trim()) {
      return data.message;
    }
  } catch {
    // Fall through to text/status below.
  }
  const text = await response.text().catch(() => "");
  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
