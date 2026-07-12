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
import {
  type CaptureBudgetState,
  type CapturePriorityReason,
  type CatalogueLens,
  type CatalogueMatch,
} from "@fluncle/contracts";
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
import { Label } from "@fluncle/ui/components/label";
import { Progress } from "@fluncle/ui/components/progress";
import { Switch } from "@fluncle/ui/components/switch";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getCatalogueCaptureState } from "@/lib/server/capture-budget";
import {
  type CatalogueSummary,
  type CatalogueTrackItem,
  getCatalogueSummary,
  listCatalogueTracks,
} from "@/lib/server/catalogue";
import { albumCoverAtSize } from "@/lib/media";

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

type CataloguePayload = {
  budget: CaptureBudgetState;
  summary: CatalogueSummary;
  tracks: CatalogueTrackItem[];
};

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

    const [tracks, summary, budget] = await Promise.all([
      listCatalogueTracks(lens, 50),
      getCatalogueSummary(),
      // The spend, read through the SAME function the capture queue's brake obeys — so what he
      // sees here and what the machine does cannot drift.
      getCatalogueCaptureState(),
    ]);

    return { budget, summary, tracks };
  });

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/catalogue")({
  // The lens is view state, so it deep-links (the placement contract): a pasted URL restores
  // the view, and a reload keeps it.
  validateSearch: (search: Record<string, unknown>): CatalogueSearch => ({
    lens:
      search.lens === "capture" ? "capture" : search.lens === "quarantine" ? "quarantine" : "ear",
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

  // THE KILL SWITCH. It reads back the server's recomputed state rather than assuming the flip
  // landed, because this is the control he reaches for when the bill is climbing — the one
  // place a hopeful optimistic update would be a lie.
  const setPaused = useMutation({
    mutationFn: (paused: boolean) => putCaptureBudget({ paused }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  // THE WRONG-AUDIO OVERRIDE. The operator disagrees with a quarantine — "this capture is fine".
  // It flips the row to `quarantine-cleared` (a sticky state the sweep never re-quarantines) and
  // re-reads, so the list reflects the server's verdict rather than an optimistic guess.
  const clearAudio = useMutation({
    mutationFn: (trackId: string) => postClearWrongAudio(trackId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATALOGUE_KEY }),
  });

  const { budget, summary, tracks } = data;

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
          {/* The wrong-audio holding pen — a QUIET pill, shown only when there is something in
              it (or the operator is looking at it), so a clean catalogue never advertises a
              section that is empty. */}
          {summary.quarantined > 0 || lens === "quarantine" ? (
            <LensPill
              active={lens === "quarantine"}
              count={summary.quarantined}
              label="Wrong audio"
              onClick={() => void navigate({ search: { lens: "quarantine" } })}
            />
          ) : null}
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
            : lens === "quarantine"
              ? "The capture for each of these landed the wrong track — its audio came back near-identical to a finding under a different title, so it was the artist's already-logged hit, not the track named here. They are held out of the ranking and queued for a fresh download. If a capture is actually fine, keep it and it rejoins the ranking."
              : "None of these has been heard yet — no audio, so no vector, so nothing to rank. Capture is metered, so they are ordered by what their metadata is worth: an artist already in the archive beats a label already in the archive beats a label the crawler may dig from. A label you ruled out sinks to the bottom, whoever is on it."}
        </p>

        {/* THE SPEND, on the capture lens. It lives here and not on a settings page because
            this is the list of tracks the money would be spent ON — the cost belongs next to
            the thing being bought, where he is already looking when he decides. */}
        {lens === "capture" ? (
          <CaptureBudgetCard
            budget={budget}
            onToggle={(paused) => setPaused.mutate(paused)}
            pending={setPaused.isPending}
          />
        ) : null}

        {tracks.length === 0 ? (
          <EmptyCatalogue lens={lens} summary={summary} />
        ) : (
          <ObjectList>
            {tracks.map((track) => (
              <CatalogueRow
                clearing={clearAudio.isPending && clearAudio.variables === track.trackId}
                key={track.trackId}
                lens={lens}
                onClear={() => clearAudio.mutate(track.trackId)}
                track={track}
              />
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
  // The quarantine lens is clean when nothing is quarantined — the GOOD state, said plainly and
  // independent of whether the catalogue is empty (a bad capture is a per-row event, not a
  // catalogue-wide one).
  if (lens === "quarantine") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BinocularsIcon aria-hidden="true" weight="thin" />
          </EmptyMedia>
          <EmptyTitle>No wrong-audio captures</EmptyTitle>
          <EmptyDescription>
            Every capture matched the track it was for. When one comes back as the artist&apos;s
            other, already-logged tune instead, it lands here to be re-captured.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

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

function CatalogueRow({
  clearing,
  lens,
  onClear,
  track,
}: {
  clearing: boolean;
  lens: CatalogueLens;
  onClear: () => void;
  track: CatalogueTrackItem;
}) {
  return (
    <ObjectRow
      trailing={
        <>
          {/* THE DUPLICATE MARKER. When this row is the same recording as a finding, it reads
              as "already in the archive" rather than a discovery — the honest register on both
              lenses. On capture it REPLACES the ladder chip (a duplicate is never bought, so the
              rung is moot); on ear the score stays too, because the ~1.0 IS the tell. */}
          {lens === "quarantine" ? (
            <Badge className="whitespace-nowrap" variant="outline">
              Wrong audio
            </Badge>
          ) : track.duplicateOf ? (
            <Badge className="whitespace-nowrap" variant="outline">
              Already logged
            </Badge>
          ) : lens === "capture" ? (
            <Badge className="whitespace-nowrap" variant="secondary">
              {captureTierLabel(track.captureReason)}
            </Badge>
          ) : null}
          {lens === "ear" ? (
            <span
              aria-label={`Similarity to its nearest finding: ${formatScore(track.nearestFindingScore)}`}
              className="text-sm font-medium tabular-nums"
            >
              {formatScore(track.nearestFindingScore)}
            </span>
          ) : null}
          {/* THE OVERRIDE. On the quarantine lens the operator can overrule a wrong-audio verdict
              — "keep it, this capture is fine" — and the row rejoins the ranking. Named plainly
              ("Keep it"), not dressed up: it is a literal control, not chrome. */}
          {lens === "quarantine" ? (
            <Button disabled={clearing} onClick={onClear} size="sm" variant="outline">
              {clearing ? (
                <CircleNotchIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                  weight="bold"
                />
              ) : null}
              Keep it
            </Button>
          ) : null}
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
  // The wrong-audio WHY names the finding the capture was mistaken FOR — the evidence that this
  // row's audio was the artist's other, already-logged track, not the track named here.
  if (lens === "quarantine") {
    return track.nearestFinding ? (
      <MatchLine lead="Its audio came back as" match={track.nearestFinding} />
    ) : (
      "Its audio matched a track already in the archive."
    );
  }

  // The duplicate WHY wins on both lenses: "you already logged this one." It NAMES the finding
  // (coordinate, artists, title) — the same evidence line the nearest-finding WHY carries.
  if (track.duplicateOf) {
    return <MatchLine lead="Already in the archive —" match={track.duplicateOf} />;
  }

  if (lens === "capture") {
    return captureWhy(track.captureReason);
  }

  const match = track.nearestFinding;

  if (!match) {
    return "Nothing to compare it to yet.";
  }

  return <MatchLine lead="Closest to" match={match} />;
}

/** A finding named in one line: the lead-in, its coordinate, and its identity. */
function MatchLine({ lead, match }: { lead: string; match: CatalogueMatch }): ReactNode {
  return (
    <>
      {lead}{" "}
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
      src={albumCoverAtSize(cover, "small")}
    />
  );
}

const GB = 1024 * 1024 * 1024;

/** GB to two places — the unit the proxy invoices in. A raw byte count is not a cost. */
function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB`;
}

/** How much of a cap is used, 0–100, clamped (an overshoot pins at full rather than overflowing). */
function usedPercent(spent: number, cap: number): number {
  if (cap <= 0) {
    return 100;
  }

  return Math.min(100, Math.round((spent / cap) * 100));
}

/**
 * THE CAPTURE BUDGET CARD — the spend, made visible, next to the thing being bought.
 *
 * Capture is the only thing Fluncle does that bills per unit of work: a residential proxy
 * charges per GB, and the queue below is a list of tracks it would spend that money on. A
 * metered thing the operator cannot SEE is a thing he cannot control, so this card answers the
 * three questions he would otherwise have to go and dig for — what did it buy in the last 24h,
 * how many GB was that, and how much is left — and puts the kill switch in the same glance.
 *
 * The findings line is not a footnote. It is the promise that stopping the catalogue never
 * stops the archive: pausing here changes nothing about a banger he actually logged.
 */
function CaptureBudgetCard({
  budget,
  onToggle,
  pending,
}: {
  budget: CaptureBudgetState;
  onToggle: (paused: boolean) => void;
  pending: boolean;
}) {
  const stopped = !budget.open;
  const capReached =
    budget.closedReason === "bytes_spent" || budget.closedReason === "tracks_spent";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Switch
          aria-label="Let the catalogue spend on audio capture"
          checked={!budget.paused}
          disabled={pending}
          id="catalogue-capture-switch"
          onCheckedChange={(next) => onToggle(!next)}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor="catalogue-capture-switch">Buy audio for the catalogue</Label>
          <p className="text-sm text-muted-foreground">
            {budget.paused
              ? "Stopped. Nothing down here is costing you anything. Your findings still capture as normal."
              : capReached
                ? "Running, but the last 24h is spent. It picks up again as the window rolls."
                : "Running. It buys the top of the queue below, up to the budget, and stops."}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Meter
          detail={`of ${budget.budget.dailyTracks}`}
          label={`Bought (${budget.windowHours}h)`}
          percent={usedPercent(budget.spend.tracks, budget.budget.dailyTracks)}
          value={`${budget.spend.tracks} ${budget.spend.tracks === 1 ? "track" : "tracks"}`}
        />
        <Meter
          detail={`of ${formatGb(budget.budget.dailyBytes)}`}
          label="Downloaded"
          percent={usedPercent(budget.spend.bytes, budget.budget.dailyBytes)}
          value={formatGb(budget.spend.bytes)}
        />
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-muted-foreground">Left in the window</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums">
            {stopped ? (
              <span className="text-muted-foreground">
                {budget.paused ? "Stopped by you" : "Spent"}
              </span>
            ) : (
              <>
                {budget.remainingTracks} {budget.remainingTracks === 1 ? "track" : "tracks"} ·{" "}
                {formatGb(budget.remainingBytes)}
              </>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** One cap, as a number and a bar. The bar is what makes "nearly spent" readable at a glance. */
function Meter({
  detail,
  label,
  percent,
  value,
}: {
  detail: string;
  label: string;
  percent: number;
  value: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 space-y-1.5">
        <span className="block text-sm font-medium tabular-nums">
          {value} <span className="font-normal text-muted-foreground">{detail}</span>
        </span>
        <Progress aria-label={`${label}: ${value} ${detail}`} value={percent} />
      </dd>
    </div>
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

// The operator-tier wrong-audio override (POST /admin/catalogue/wrong-audio/clear). Flips one
// quarantined row to `quarantine-cleared`, the sticky state the sweep never re-quarantines.
async function postClearWrongAudio(trackId: string): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/wrong-audio/clear", {
    body: JSON.stringify({ trackId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

/** The operator-tier kill switch / cap write (PUT /admin/catalogue/capture-budget). */
async function putCaptureBudget(input: {
  dailyBytes?: number;
  dailyTracks?: number;
  paused?: boolean;
}): Promise<void> {
  const response = await fetch("/api/v1/admin/catalogue/capture-budget", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
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
