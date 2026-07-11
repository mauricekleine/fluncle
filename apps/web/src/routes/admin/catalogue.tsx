import {
  ArrowsClockwiseIcon,
  CircleNotchIcon,
  BinocularsIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode } from "react";
import { type CapturePriorityReason, type CatalogueLens } from "@fluncle/contracts";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@fluncle/ui/components/empty";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type CatalogueSummary,
  type CatalogueTrackItem,
  getCatalogueSummary,
  listCatalogueTracks,
} from "@/lib/server/catalogue";
import { spotifyAlbumImageAtSize } from "@/lib/media";

// THE EAR — `/admin/catalogue` (docs/the-ear.md).
//
// A CATALOGUE TRACK is a `tracks` row with no `findings` row: a track the archive knows and
// Fluncle never logged. This page ranks them, and it is deliberately NOT a queue to grind.
//
// ── IT IS A TELESCOPE, NOT A CONVEYOR BELT ──────────────────────────────────────────────
// The operator finds ~15 bangers a week, so volume is not his constraint — but that pace is
// shallow and recency-biased: he sees whatever the feeds put in front of him, while whole
// regions of the genre (older releases, small labels, the long tail) never cross his path.
// This page points at the tracks sitting near what he already loves and never reached him. So
// it is a short, high-conviction list he WANTS to open. If it ever feels like a backlog to
// process, it has failed, and the fix is to show fewer rows — never more.
//
// ── EVERY ROW CARRIES ITS WHY ───────────────────────────────────────────────────────────
// A bare score is not a reason. Each row names the finding it matched ("Closest to 012.2.4L ·
// Krakota — See For Miles"), because an instrument the operator cannot interrogate is one he
// stops looking through. The score is the claim; the finding is the evidence.
//
// ── THE PAGE DOES NO VECTOR MATH ────────────────────────────────────────────────────────
// It reads columns the `rank_catalogue` sweep precomputed and sorts on an index. Ranking at
// request time would be a 10k × 60 cross join over 1024-d vectors, per page load. See
// lib/server/catalogue.ts.
//
// ── AND NOTHING HERE IS LIT LIKE A FINDING ──────────────────────────────────────────────
// No coordinate, no gold, no note, no video — a catalogue row cannot carry any of them,
// because those columns live on `findings` and this row has none. The rows are the same shape
// as a finding's and deliberately not the same weight: he has not been to these ones.

const CATALOGUE_KEY = ["admin", "catalogue"] as const;

type CataloguePayload = { summary: CatalogueSummary; tracks: CatalogueTrackItem[] };

type CatalogueSearch = { lens: CatalogueLens };

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchCatalogue = createServerFn({ method: "GET" })
  .inputValidator((lens: CatalogueLens) => lens)
  .handler(async ({ data: lens }): Promise<CataloguePayload> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const [tracks, summary] = await Promise.all([
      listCatalogueTracks(lens, 50),
      getCatalogueSummary(),
    ]);

    return { summary, tracks };
  });

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/catalogue")({
  // The lens is view state, so it deep-links (the placement contract): a pasted URL restores
  // the view, and a reload keeps it.
  validateSearch: (search: Record<string, unknown>): CatalogueSearch => ({
    lens: search.lens === "capture" ? "capture" : "ear",
  }),
  loaderDeps: ({ search }) => ({ lens: search.lens }),
  beforeLoad: () => ensureAdmin(),
  loader: ({ deps }) => fetchCatalogue({ data: deps.lens }),
  component: AdminCataloguePage,
});

function AdminCataloguePage() {
  const initial = Route.useLoaderData();
  const { lens } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchCatalogue({ data: lens }),
    queryKey: [...CATALOGUE_KEY, lens],
    refetchOnWindowFocus: true,
  });

  // The sweep, by hand. It is a periodic job, but the operator must be able to poke it after
  // logging a finding and watch the ranking move — otherwise the list's freshness is a thing
  // he has to take on faith. `remaining > 0` means the backlog needs more ticks.
  const rank = useMutation({
    mutationFn: () => postRank(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  const { summary, tracks } = data;

  return (
    <AdminShell
      headerActions={
        <Button disabled={rank.isPending} onClick={() => rank.mutate()} size="sm" variant="outline">
          {rank.isPending ? (
            <CircleNotchIcon
              aria-hidden="true"
              className="motion-safe:animate-spin"
              weight="bold"
            />
          ) : (
            <ArrowsClockwiseIcon aria-hidden="true" weight="bold" />
          )}
          Re-rank
        </Button>
      }
      subheader={
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5">
          <LensPill
            active={lens === "ear"}
            count={summary.ranked}
            label="Closest to a finding"
            onClick={() => void navigate({ search: { lens: "ear" } })}
          />
          <LensPill
            active={lens === "capture"}
            count={summary.awaitingCapture}
            label="Next to capture"
            onClick={() => void navigate({ search: { lens: "capture" } })}
          />
          {rank.isError ? (
            <span className="ml-2 text-xs text-destructive" role="alert">
              {rank.error instanceof Error ? rank.error.message : "The re-rank failed."}
            </span>
          ) : null}
        </div>
      }
      subtitle={summaryLine(summary)}
      title="Catalogue"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {lens === "ear"
            ? "Tracks nobody logged, ranked by how close each one sits to its nearest finding. Every row names the finding it matched — that claim is the whole list. Nothing here has a coordinate, and none of it is a finding until Fluncle says so."
            : "None of these has been heard yet — no audio, so no vector, so nothing to rank. Capture is metered, so they are ordered by what their metadata is worth: an artist already in the archive beats a label already in the archive beats a label the crawler may dig from. A label you ruled out sinks to the bottom, whoever is on it."}
        </p>

        {tracks.length === 0 ? (
          <EmptyCatalogue lens={lens} summary={summary} />
        ) : (
          <ObjectList>
            {tracks.map((track) => (
              <CatalogueRow key={track.trackId} lens={lens} track={track} />
            ))}
          </ObjectList>
        )}
      </div>
    </AdminShell>
  );
}

/** The quiet line under the title: what the catalogue holds, and how much of it is ranked. */
function summaryLine(summary: CatalogueSummary): string {
  if (summary.total === 0) {
    return "Nothing out there yet";
  }

  const parts = [`${summary.total} not logged`];

  if (summary.ranked > 0) {
    parts.push(`${summary.ranked} ranked`);
  }

  if (summary.awaitingCapture > 0) {
    parts.push(`${summary.awaitingCapture} waiting on audio`);
  }

  if (summary.awaitingRank > 0) {
    parts.push(`${summary.awaitingRank} unranked`);
  }

  return parts.join(" · ");
}

// The honest empty state — and today it is the REAL state: the crawler does not exist yet, so
// the catalogue holds nothing. Three different nothings, and they mean different things, so
// the page says which one it is instead of showing one shrug for all three.
function EmptyCatalogue({ lens, summary }: { lens: CatalogueLens; summary: CatalogueSummary }) {
  const nothingAtAll = summary.total === 0;
  const title = nothingAtAll
    ? "Nothing out there yet"
    : lens === "ear"
      ? "Nothing to listen to yet"
      : "Everything in has been heard";
  const description = nothingAtAll
    ? "No track the archive knows is uncertified — there is nothing out there to point at. When tracks start arriving, the ones sitting closest to a finding surface here first."
    : lens === "ear"
      ? `${summary.total} tracks are in, and not one has been heard yet. A track has no vector until its audio is captured, so until then there is nothing to rank. They are queued under "Next to capture".`
      : "Every uncertified track in the archive already has its audio. Nothing is waiting to be captured.";

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BinocularsIcon aria-hidden="true" weight="thin" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {summary.awaitingRank > 0 ? (
        <EmptyContent>
          <p className="text-xs text-muted-foreground">
            {summary.awaitingRank} {summary.awaitingRank === 1 ? "track has" : "tracks have"} never
            been ranked. Re-rank to work through them.
          </p>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function LensPill({
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
      <Badge className="ml-1 tabular-nums" variant={active ? "outline" : "secondary"}>
        {count}
      </Badge>
    </Button>
  );
}

function CatalogueRow({ lens, track }: { lens: CatalogueLens; track: CatalogueTrackItem }) {
  return (
    <ObjectRow
      trailing={
        <>
          {lens === "ear" ? (
            <span
              aria-label={`Similarity to its nearest finding: ${formatScore(track.nearestFindingScore)}`}
              className="text-sm font-medium tabular-nums"
            >
              {formatScore(track.nearestFindingScore)}
            </span>
          ) : (
            <Badge className="whitespace-nowrap" variant="secondary">
              {captureTierLabel(track.captureReason)}
            </Badge>
          )}
          {track.spotifyUrl ? (
            // The one thing the operator came here to do: HEAR it. There is no in-app preview
            // for a catalogue track — the `/ln` relay resolves through `findings`, by design —
            // so the audition is the real one, in Spotify.
            <Button
              // `nativeButton={false}` is required when the render node is an <a>: Base UI
              // otherwise keeps native button semantics on a link, which breaks a11y.
              nativeButton={false}
              render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
              size="sm"
              variant="outline"
            >
              Listen
            </Button>
          ) : null}
        </>
      }
    >
      <ObjectLead
        leading={<CatalogueCover cover={track.albumImageUrl} />}
        subtitle={
          <>
            <span className="truncate">{track.artists.join(", ")}</span>
            {track.label ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{track.label}</span>
              </>
            ) : null}
            {track.bpm ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{Math.round(track.bpm)} BPM</span>
              </>
            ) : null}
            {/* THE WHY, on its own line (basis-full). It is not decoration and it is not
                secondary to the score: the score is the claim, and this is the evidence for
                it. Without it the number is an oracle, and an oracle gets ignored. */}
            <span className="basis-full truncate text-foreground/80">
              <Why lens={lens} track={track} />
            </span>
          </>
        }
        title={track.title}
      />
    </ObjectRow>
  );
}

/** The row's reason for being where it is, in one line. */
function Why({ lens, track }: { lens: CatalogueLens; track: CatalogueTrackItem }): ReactNode {
  if (lens === "capture") {
    return captureWhy(track.captureReason);
  }

  const match = track.nearestFinding;

  if (!match) {
    return "Nothing to compare it to yet.";
  }

  return (
    <>
      Closest to{" "}
      {match.logId ? (
        <span className="font-mono text-[11px] tracking-tight tabular-nums">{match.logId}</span>
      ) : null}{" "}
      {match.artists.join(", ")} — {match.title}
    </>
  );
}

/** The capture ladder, spoken. Each rung is a claim about a track nobody has heard. */
function captureWhy(reason: CapturePriorityReason | null): string {
  switch (reason?.kind) {
    case "artist": {
      return `${reason.name} is already in the archive.`;
    }
    case "label": {
      return `${reason.name} already carries a finding.`;
    }
    case "seed-label": {
      return `${reason.name} is a label the crawler digs from.`;
    }
    case "skipped-label": {
      // The veto, said plainly. The row is still here — it is just last, and it says why.
      return `${reason.name} is not your lane. Ranked last, kept anyway.`;
    }
    default: {
      return "Nothing ties it to the archive yet.";
    }
  }
}

/** The rung, as a chip — quiet data, never an alarm. A cold track is not a failure. */
function captureTierLabel(reason: CapturePriorityReason | null): string {
  switch (reason?.kind) {
    case "artist": {
      return "Known artist";
    }
    case "label": {
      return "Known label";
    }
    case "seed-label": {
      return "Seed label";
    }
    case "skipped-label": {
      return "Not our lane";
    }
    default: {
      return "Cold";
    }
  }
}

/** Cosine similarity, to two places. The number the whole list is sorted by. */
function formatScore(score: number | null): string {
  return typeof score === "number" ? score.toFixed(2) : "—";
}

// The cover, at the shared size-11 Object Row footprint — and deliberately WITHOUT the
// finding plate's gold story-ring: that ring is certification light, and Fluncle never
// certified this. No cover art falls back to the shared ObjectGlyph.
function CatalogueCover({ cover }: { cover: string | null }) {
  if (!cover) {
    return <ObjectGlyph icon={WaveformIcon} />;
  }

  return (
    <img
      alt=""
      className="size-11 shrink-0 rounded-md border border-border object-cover"
      src={spotifyAlbumImageAtSize(cover, "small")}
    />
  );
}

// One tick of the agent-tier `rank_catalogue` sweep (POST /admin/catalogue/rank). The browser
// carries the admin grant cookie; the fetch mirrors the labels/galaxies calls.
async function postRank(): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/rank", {
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
    method: "POST",
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
