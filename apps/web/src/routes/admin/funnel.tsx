import { Button } from "@fluncle/ui/components/button";
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CircleNotchIcon,
  DownloadSimpleIcon,
  GaugeIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { StatTile } from "@/components/admin/stat-tile";
import {
  CHART_H,
  CHART_W,
  chartGeometry,
  type FunnelStageBar,
  type GrowthPoint,
  growthPoints,
  latestThroughput,
  stageBars,
} from "@/lib/funnel-view";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type FunnelView, getFunnel, getFunnelLive } from "@/lib/server/funnel";

// The `/admin/funnel` station — the catalogue pipeline (crawl → anchor → capture →
// analyze/embed → rec-eligible → certified) on one page (docs/rfcs/catalogue-funnel-rfc.md,
// U2). Three bands: the funnel (proportional stage bars, each a link to its operating
// surface), the meters (the operator's spend levers — capture budget, anchor bench, frontier
// depth), and the charts (catalogue growth, eligible-pool growth, and per-stage daily
// throughput from the snapshot series).
//
// ── DATA FLOW ─────────────────────────────────────────────────────────────────
// The admin loader-seeded react-query hybrid (AGENTS.md): a GET server fn reads `getFunnel`
// SERVER-SIDE in-process (the browser-admin pattern — no oRPC client, no CORS, exactly as
// `/admin/usage` reads `getCostInsights`), the loader seeds it, and a focus-refetching
// `useQuery` keeps it honest on tab-back. All arranging happens in the pure `funnel-view.ts`
// helpers, so the page itself only draws.
//
// ── SNAPSHOT-BACKED, REFRESH ON DEMAND ──────────────────────────────────────────
// `getFunnel` serves the live block from the latest nightly snapshot (funnel.ts), so plain
// navigation and the focus-refetch never trigger the growing-table scan storm — they pay only a
// cheap capture-budget read. The header states the block's age ("as of <day>"); a "Refresh live"
// action calls `getFunnelLive` (the full recompute) and writes the fresh view into the query cache.
// A short `staleTime` keeps a burst of focus-refetches from re-hitting even the cheap read.
//
// ── NO BACKFILL ───────────────────────────────────────────────────────────────
// The snapshot series starts at the first real daily tick and grows honestly (the RFC's
// deliberate no-backfill rule). So every chart carries a short-data state — a single dry
// line, never a fabricated zero-baseline — until two snapshots exist.

const FUNNEL_KEY = ["admin", "funnel"] as const;

const numberFormatter = new Intl.NumberFormat("en-US");
const formatCount = (value: number) => numberFormatter.format(value);

// UTC-pinned "Jul 18" so the server render matches hydration exactly (the /reach precedent).
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const formatDay = (day: string) => dateFormatter.format(new Date(`${day}T00:00:00.000Z`));

const GB = 1024 * 1024 * 1024;
// GB to one place — the unit the capture proxy invoices in (the /admin/catalogue idiom).
const formatGb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

// A signed movement: "+4,900" / "−190" (a real minus), "0" flat. The pipe-width glance.
function formatDelta(delta: number): string {
  if (delta > 0) {
    return `+${formatCount(delta)}`;
  }

  if (delta < 0) {
    return `−${formatCount(Math.abs(delta))}`;
  }

  return "0";
}

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// The one-call read, server-side + in-process (no HTTP, no CORS), re-checking the grant. The DEFAULT
// (snapshot-backed) read behind the loader + focus-refetch — never the scan storm.
const fetchFunnel = createServerFn({ method: "GET" }).handler(async (): Promise<FunnelView> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return getFunnel();
});

// The operator's "refresh live" recompute — the full scan, on demand only. Same in-process grant
// re-check; the button below writes its result into the query cache.
const refreshFunnel = createServerFn({ method: "GET" }).handler(async (): Promise<FunnelView> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return getFunnelLive();
});

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/funnel")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchFunnel(),
  component: FunnelPage,
});

function FunnelPage() {
  const initial = Route.useLoaderData();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchFunnel(),
    queryKey: FUNNEL_KEY,
    refetchOnWindowFocus: true,
    // A burst of tab-backs should not re-hit even the cheap snapshot read on every focus.
    staleTime: 20_000,
  });

  // "Refresh live" runs the full recompute and writes it straight into the cache — no invalidation
  // (which would re-run the cheap snapshot read and drop the fresh live block back to snapshot-backed).
  const refresh = useMutation({
    mutationFn: () => refreshFunnel(),
    onSuccess: (fresh) => queryClient.setQueryData(FUNNEL_KEY, fresh),
  });

  const { freshness, live, series } = data;
  const bars = stageBars(live.stages, live.queues);
  const subtitle = `${formatCount(live.stages.crawled)} crawled · ${formatCount(live.stages.certified)} certified`;

  return (
    <AdminShell
      headerActions={<RefreshControl freshness={freshness} refresh={refresh} />}
      subtitle={subtitle}
      title="Funnel"
    >
      <div className="space-y-8 p-4 sm:p-5">
        <FunnelBand bars={bars} />
        <MetersBand meters={live.meters} />
        <ChartsBand series={series} />
      </div>
    </AdminShell>
  );
}

// The freshness readout + the "refresh live" trigger. The label states how old the live block is
// (the snapshot's day), or "Live" right after a recompute; the button runs the full scan on demand.
function RefreshControl({
  freshness,
  refresh,
}: {
  freshness: FunnelView["freshness"];
  refresh: { isPending: boolean; mutate: () => void };
}) {
  const label = freshness.live
    ? "Live"
    : freshness.day
      ? `as of ${formatDay(freshness.day)}`
      : "no snapshot yet";

  return (
    <>
      <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">{label}</span>
      <Button
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
        size="sm"
        variant="outline"
      >
        {refresh.isPending ? (
          <CircleNotchIcon
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
            weight="bold"
          />
        ) : (
          <ArrowClockwiseIcon aria-hidden="true" className="size-4" />
        )}
        Refresh live
      </Button>
    </>
  );
}

// ── The funnel band ────────────────────────────────────────────────────────────
// Each stage is a real link to its operating surface (WCAG AA + keyboard reach: an anchor,
// visible focus ring), drawn with an honest proportional-width bar. The bar is decorative;
// the numbers beside it carry the meaning, so the bar is aria-hidden.

function FunnelBand({ bars }: { bars: FunnelStageBar[] }) {
  return (
    <section aria-label="The funnel" className="space-y-3">
      <BandHeading>The pipeline, crawl to certified</BandHeading>
      <ul className="space-y-1.5">
        {bars.map((bar) => (
          <li key={bar.key}>
            <StageBarRow bar={bar} />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Bar width is each stage against the widest. Open a stage to work it.
      </p>
    </section>
  );
}

const STAGE_LINK_CLASS =
  "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function StageBarRow({ bar }: { bar: FunnelStageBar }) {
  const body = <StageBarBody bar={bar} />;

  // The `to` must be a literal at each Link so TanStack infers each route's own required search
  // (a union `to` would force one merged search shape onto every branch). Two concrete cases,
  // one per StageLink shape — both real client-side <Link>s (keyboard-reachable, focus-ringed).
  if (bar.link.to === "/admin/findings") {
    return (
      <Link className={STAGE_LINK_CLASS} search={{ mix: "all", stage: "all" }} to="/admin/findings">
        {body}
      </Link>
    );
  }

  return (
    <Link className={STAGE_LINK_CLASS} search={{ lens: bar.link.lens }} to="/admin/catalogue">
      {body}
    </Link>
  );
}

function StageBarBody({ bar }: { bar: FunnelStageBar }) {
  // A non-empty stage keeps a sliver of bar so a tiny exit still reads and stays clickable.
  const width = bar.total > 0 ? Math.max(bar.widthPct, 2) : 0;

  return (
    <>
      <span className="w-24 shrink-0 text-sm font-medium">{bar.label}</span>
      <span aria-hidden="true" className="relative h-6 min-w-0 flex-1 overflow-hidden rounded">
        <span className="absolute inset-0 rounded bg-card/60" />
        {/* The Ignition Rule (DESIGN.md, One Sun): the bar rests neutral and heats to gold
            only on interaction — the sun on this page is spent on the live-edge dots and the
            capture-budget lever, not on seven bars at rest. */}
        <span
          className="absolute inset-y-0 left-0 rounded bg-foreground/10 transition-colors group-hover:bg-primary/25"
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="flex shrink-0 items-baseline gap-2 text-right tabular-nums">
        <span className="text-sm font-medium">{formatCount(bar.total)}</span>
        {/* The queued-behind cell holds a fixed width across every row so the totals line up. The
            anchor row shows the two populations (the embedded head the sweep works, and the
            metadata still awaiting audio); every other row shows the single queued figure. */}
        {bar.queuedSplit ? (
          <span className="w-24 text-xs text-muted-foreground sm:w-56">
            {formatCount(bar.queuedSplit.ready)} ready ·{" "}
            {formatCount(bar.queuedSplit.awaitingAudio)} awaiting audio
          </span>
        ) : bar.queued !== undefined ? (
          <span className="w-24 text-xs text-muted-foreground sm:w-56">
            {formatCount(bar.queued)} queued
          </span>
        ) : (
          <span aria-hidden="true" className="w-24 sm:w-56" />
        )}
      </span>
      <ArrowRightIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </>
  );
}

// ── The meters band ────────────────────────────────────────────────────────────
// The operator's spend levers, as stat tiles (the shared /admin/usage + /admin/costs
// vocabulary): capture budget remaining today (the accent lever), the anchor re-ask bench,
// and the crawl frontier still to drain.

function MetersBand({ meters }: { meters: FunnelView["live"]["meters"] }) {
  const { captureBudget: budget } = meters;
  const captureValue = budget.paused
    ? "Paused"
    : `${formatGb(budget.remainingBytes)} · ${formatCount(budget.remainingTracks)}`;
  const captureHint = budget.paused
    ? "capture is paused — nothing spends today"
    : `left of ${formatGb(budget.dailyBytes)} · ${formatCount(budget.dailyTracks)} tracks per ${budget.windowHours}h`;

  return (
    <section aria-label="The meters" className="space-y-3">
      <BandHeading>The spend levers</BandHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          accent
          hint={captureHint}
          icon={<GaugeIcon aria-hidden="true" className="size-4" weight="fill" />}
          label="Capture budget left today"
          value={captureValue}
        />
        <StatTile
          hint="attempted inside the re-ask window — benched, not re-billed yet"
          icon={<StackIcon aria-hidden="true" className="size-4" />}
          label="Anchor bench"
          value={formatCount(meters.anchorBackoff)}
        />
        <StatTile
          hint="metadata still to acquire — the crawl frontier left to drain"
          icon={<DownloadSimpleIcon aria-hidden="true" className="size-4" />}
          label="Frontier pending"
          value={formatCount(meters.frontierPending)}
        />
      </div>
    </section>
  );
}

// ── The charts band ────────────────────────────────────────────────────────────
// Growth per day (catalogue total, eligible pool) and per-stage daily throughput, all from
// the snapshot series. Every chart has an honest short-data state: with fewer than two
// snapshots there is no line to draw, so the chart says so rather than inventing a baseline.

function ChartsBand({ series }: { series: FunnelView["series"] }) {
  const throughput = latestThroughput(series);

  return (
    <section aria-label="The charts" className="space-y-6">
      <BandHeading>Growth per day</BandHeading>
      <div className="grid gap-6 lg:grid-cols-2">
        <GrowthChart
          label="Catalogue"
          points={growthPoints(series, "crawled")}
          sublabel="rows crawled, all-time"
        />
        <GrowthChart
          label="Rec-eligible pool"
          points={growthPoints(series, "recEligible")}
          sublabel="rows clearing the eligibility gate"
        />
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Moved yesterday, per stage</h3>
        {throughput ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {throughput.stages.map((stage) => (
              <li className="flex items-center gap-3 px-3 py-2.5 sm:px-4" key={stage.key}>
                <span className="min-w-0 flex-1 truncate text-sm">{stage.label}</span>
                <DeltaValue delta={stage.delta} />
              </li>
            ))}
          </ul>
        ) : (
          <DryLine>
            A day&rsquo;s movement needs two snapshots; the next daily tick fills this in.
          </DryLine>
        )}
        {throughput ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatDay(throughput.from)} → {formatDay(throughput.to)}
          </p>
        ) : undefined}
      </div>
    </section>
  );
}

// One growth line: the house SVG line-chart (the /reach console idiom — a translucent area
// under a cream line with min/max rails and one gold live-edge dot). A single point draws the
// dot and its reading, never a fabricated line.
function GrowthChart({
  label,
  points,
  sublabel,
}: {
  label: string;
  points: GrowthPoint[];
  sublabel: string;
}) {
  const single = points.length < 2;
  const latest = points[points.length - 1];
  const first = points[0];
  const geometry = chartGeometry(points);

  return (
    <figure aria-label={`${label} over time`} className="m-0 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="text-xs text-muted-foreground">{sublabel}</span>
      </div>

      {points.length === 0 ? (
        <DryLine>No snapshots yet; the line starts at the first daily tick.</DryLine>
      ) : (
        <div className="relative">
          <svg
            aria-hidden="true"
            className="h-40 w-full text-foreground/80"
            preserveAspectRatio="none"
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          >
            {single ? undefined : (
              <>
                <path className="fill-foreground/[0.06]" d={geometry.area} />
                <polyline
                  fill="none"
                  points={geometry.line}
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            {/* The One Sun: the live edge is the only gold on the chart. */}
            <circle
              className="fill-primary motion-safe:animate-pulse"
              cx={geometry.last.x}
              cy={geometry.last.y}
              r={3.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {single ? undefined : (
            <>
              <span className="pointer-events-none absolute left-0 top-0 text-[11px] tabular-nums text-muted-foreground">
                {formatCount(geometry.max)}
              </span>
              {geometry.min !== geometry.max ? (
                <span className="pointer-events-none absolute bottom-0 left-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatCount(geometry.min)}
                </span>
              ) : undefined}
            </>
          )}
        </div>
      )}

      <figcaption className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        {single ? (
          latest ? (
            <span>
              {formatCount(latest.value)} · first reading {formatDay(latest.at)}. The line grows
              from here.
            </span>
          ) : (
            <span>No snapshots yet.</span>
          )
        ) : (
          <>
            <span>{first ? formatDay(first.at) : ""}</span>
            <span className="text-foreground/80">
              {latest ? formatCount(latest.value) : ""} now
            </span>
          </>
        )}
      </figcaption>
    </figure>
  );
}

// A stage's daily movement, with a direction glyph: up gained rows, down shed them, flat held.
function DeltaValue({ delta }: { delta: number }) {
  const Glyph = delta > 0 ? ArrowUpIcon : delta < 0 ? ArrowDownIcon : undefined;

  return (
    <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium tabular-nums">
      {Glyph ? (
        <Glyph aria-hidden="true" className="size-3.5 text-muted-foreground" weight="bold" />
      ) : undefined}
      <span className={delta === 0 ? "text-muted-foreground" : undefined}>
        {formatDelta(delta)}
      </span>
    </span>
  );
}

function BandHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-bold">{children}</h2>;
}

// The honest short-data placeholder: a quiet dashed line that says why there is nothing to
// draw yet, never a fake baseline (the no-backfill rule).
function DryLine({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
