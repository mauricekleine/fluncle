import {
  AnchorSimpleIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  DiscIcon,
  DownloadSimpleIcon,
  GaugeIcon,
  LinkBreakIcon,
  MusicNotesIcon,
  StackIcon,
  TagIcon,
  TrayArrowDownIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode } from "react";
import { captureTierLabelFor } from "@/lib/capture-tier";
import { ensureAdmin } from "@/lib/admin-guard";
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
import { type FunnelView, getFunnel } from "@/lib/server/funnel";

const FUNNEL_KEY = ["admin", "funnel"] as const;

const numberFormatter = new Intl.NumberFormat("en-US");
const formatCount = (value: number) => numberFormatter.format(value);

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const formatDay = (day: string) => dateFormatter.format(new Date(`${day}T00:00:00.000Z`));

const GB = 1024 * 1024 * 1024;

const formatGb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

function formatDelta(delta: number): string {
  if (delta > 0) {
    return `+${formatCount(delta)}`;
  }

  if (delta < 0) {
    return `−${formatCount(Math.abs(delta))}`;
  }

  return "0";
}

const fetchFunnel = createServerFn({ method: "GET" }).handler(async (): Promise<FunnelView> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return getFunnel();
});

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/funnel")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchFunnel(),
  component: FunnelPage,
});

function FunnelPage() {
  const initial = Route.useLoaderData();
  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchFunnel(),
    queryKey: FUNNEL_KEY,
    refetchOnWindowFocus: true,

    staleTime: 30_000,
  });

  const { live, series } = data;
  const bars = stageBars(live.stages, {
    captureBacklog: live.captureBacklog,
    queues: live.queues,
  });
  const subtitle = `${formatCount(live.stages.crawled)} crawled · ${formatCount(live.stages.certified)} certified`;

  return (
    <AdminShell subtitle={subtitle} title="Funnel">
      <div className="space-y-8 p-4 sm:p-5">
        <FunnelBand bars={bars} />
        <PublicSurfacesBand surfaces={live.publicSurfaces} />
        <MetersBand meters={live.meters} />
        <CaptureBacklogBand backlog={live.captureBacklog} />
        <ChartsBand series={series} />
      </div>
    </AdminShell>
  );
}

function FunnelBand({ bars }: { bars: FunnelStageBar[] }) {
  return (
    <section aria-label="The funnel" className="space-y-3">
      <BandHeading>The pipeline, biggest stage first</BandHeading>
      <ul className="space-y-1.5">
        {bars.map((bar) => (
          <li key={bar.key}>
            <StageBarRow bar={bar} />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Stages run biggest to smallest; bar width is each against the widest. Open a stage to work
        it.
      </p>
    </section>
  );
}

const STAGE_LINK_CLASS =
  "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function StageBarRow({ bar }: { bar: FunnelStageBar }) {
  const body = <StageBarBody bar={bar} />;

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
  const width = bar.total > 0 ? Math.max(bar.widthPct, 2) : 0;

  return (
    <>
      <span className="w-24 shrink-0 text-sm font-medium">{bar.label}</span>
      <span aria-hidden="true" className="relative h-6 min-w-0 flex-1 overflow-hidden rounded">
        <span className="absolute inset-0 rounded bg-card/60" />

        <span
          className="absolute inset-y-0 left-0 rounded bg-foreground/10 transition-colors group-hover:bg-primary/25"
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="flex shrink-0 items-baseline gap-2 text-right tabular-nums">
        <span className="text-sm font-medium">{formatCount(bar.total)}</span>

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

function PublicSurfacesBand({ surfaces }: { surfaces: FunnelView["live"]["publicSurfaces"] }) {
  return (
    <section aria-label="Public surfaces" className="space-y-3">
      <BandHeading>Live on the public web</BandHeading>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          accent
          hint="every track on /tracks — findings and catalogue rows alike"
          icon={<MusicNotesIcon aria-hidden="true" className="size-4" weight="fill" />}
          label="Tracks"
          value={formatCount(surfaces.tracks)}
        />
        <StatTile
          hint="artists with a live, indexable /artist page"
          icon={<UsersThreeIcon aria-hidden="true" className="size-4" />}
          label="Artists"
          value={formatCount(surfaces.artists)}
        />
        <StatTile
          hint="albums with a live, indexable /album page"
          icon={<DiscIcon aria-hidden="true" className="size-4" />}
          label="Albums"
          value={formatCount(surfaces.albums)}
        />
        <StatTile
          hint="labels with a live, indexable /label page"
          icon={<TagIcon aria-hidden="true" className="size-4" />}
          label="Labels"
          value={formatCount(surfaces.labels)}
        />
      </div>
    </section>
  );
}

function MetersBand({ meters }: { meters: FunnelView["live"]["meters"] }) {
  const { captureBudget: budget } = meters;
  const captureValue = budget.paused
    ? "Paused"
    : `${formatGb(budget.remainingBytes)} · ${formatCount(budget.remainingTracks)}`;

  const captureHint = budget.paused
    ? "capture is paused — nothing spends today"
    : `${budget.open ? "open" : "shut"} · left of ${formatGb(budget.dailyBytes)} · ${formatCount(budget.dailyTracks)} tracks per ${budget.windowHours}h`;

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

function CaptureBacklogBand({ backlog }: { backlog: FunnelView["live"]["captureBacklog"] }) {
  const unanchored = backlog.authorized - backlog.authorizedAnchored;

  return (
    <section aria-label="The capture backlog" className="space-y-3">
      <BandHeading>Waiting on the capture budget</BandHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          hint="authorized rows with no audio yet — the meter above says whether any of it drains"
          icon={<TrayArrowDownIcon aria-hidden="true" className="size-4" />}
          label="Backlog"
          value={formatCount(backlog.authorized)}
        />
        <StatTile
          hint="already carry a Spotify anchor — audio here can reach the rec pool"
          icon={<AnchorSimpleIcon aria-hidden="true" className="size-4" />}
          label="Anchored"
          value={formatCount(backlog.authorizedAnchored)}
        />
        <StatTile
          hint="no anchor yet — audio here waits on anchoring before it counts"
          icon={<LinkBreakIcon aria-hidden="true" className="size-4" />}
          label="Unanchored"
          value={formatCount(unanchored)}
        />
      </div>
      {backlog.tiers.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <caption className="sr-only">
              The authorized capture backlog by pre-audio tier and anchor state
            </caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-1 text-left font-medium" scope="col">
                  Tier
                </th>
                <th className="py-1 text-right font-medium" scope="col">
                  Anchored
                </th>
                <th className="py-1 text-right font-medium" scope="col">
                  Unanchored
                </th>
                <th className="py-1 text-right font-medium" scope="col">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {backlog.tiers.map((row) => (
                <tr className="border-t border-border" key={row.tier}>
                  <th className="py-1.5 text-left font-medium" scope="row">
                    {captureTierLabelFor(row.tier)}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">{formatCount(row.anchored)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatCount(row.unanchored)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatCount(row.anchored + row.unanchored)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing authorized is waiting on audio.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Highest tier drains first. A ruled-out label, a dismissed row and a long-form mix are not
        counted here — they are never bought.
      </p>
    </section>
  );
}

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

function DryLine({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
