import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  siAppstore,
  siBluesky,
  siGithub,
  siInstagram,
  siLastdotfm,
  siMixcloud,
  siNpm,
  siSpotify,
  siTelegram,
  siTiktok,
  siTwitch,
  siYoutube,
} from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { chartGeometry as sharedChartGeometry } from "@/lib/chart-geometry";
import { fluncleEntityId, siteUrl } from "@/lib/fluncle-links";
import { fluncleDescription } from "@/lib/identity";
import { jsonLdScript } from "@/lib/json-ld";
import {
  listPlatformStats,
  type PlatformStatSeries,
  type PlatformStatsView,
} from "@/lib/server/platform-stats";

type Bucket = "crew" | "hangar" | "reach";

type SimpleIcon = { readonly path: string; readonly title: string };

type PlatformDef = {
  icon?: SimpleIcon;
  label: string;
  slug: string;
};

const PLATFORMS: PlatformDef[] = [
  { icon: siSpotify, label: "Spotify", slug: "spotify" },
  { icon: siYoutube, label: "YouTube", slug: "youtube" },
  { icon: siTiktok, label: "TikTok", slug: "tiktok" },
  { icon: siInstagram, label: "Instagram", slug: "instagram" },
  { icon: siMixcloud, label: "Mixcloud", slug: "mixcloud" },
  { icon: siTwitch, label: "Twitch", slug: "twitch" },
  { icon: siTelegram, label: "Telegram", slug: "telegram" },
  { label: "Newsletter", slug: "newsletter" },
  { icon: siBluesky, label: "Bluesky", slug: "bluesky" },
  { icon: siLastdotfm, label: "Last.fm", slug: "lastfm" },
  { icon: siAppstore, label: "App Store", slug: "appstore" },
  { icon: siGithub, label: "GitHub", slug: "github" },
  { icon: siNpm, label: "npm", slug: "npm" },
];

const PLATFORM_BY_SLUG = new Map(PLATFORMS.map((p) => [p.slug, p]));

type MetricMeta = {
  bucket: Bucket;

  includesPostingBot?: boolean;
  metricLabel: string;
  platform: string;
};

const METRIC_META: Record<string, MetricMeta> = {
  "appstore:rating_count": { bucket: "crew", metricLabel: "ratings", platform: "appstore" },
  "bluesky:followers": { bucket: "crew", metricLabel: "followers", platform: "bluesky" },
  "github:stars": { bucket: "hangar", metricLabel: "stars on the repo", platform: "github" },
  "instagram:views": { bucket: "reach", metricLabel: "views", platform: "instagram" },
  "lastfm:scrobbles": { bucket: "reach", metricLabel: "scrobbles", platform: "lastfm" },
  "mixcloud:followers": { bucket: "crew", metricLabel: "followers", platform: "mixcloud" },
  "mixcloud:listens": { bucket: "reach", metricLabel: "listens", platform: "mixcloud" },
  "newsletter:audience": {
    bucket: "crew",
    metricLabel: "aboard the mothership",
    platform: "newsletter",
  },
  "npm:downloads_weekly": {
    bucket: "hangar",
    metricLabel: "CLI downloads · week",
    platform: "npm",
  },
  "spotify_playlist:playlist_saves": {
    bucket: "crew",
    metricLabel: "playlist saves",
    platform: "spotify",
  },
  "telegram:audience": {
    bucket: "crew",
    includesPostingBot: true,
    metricLabel: "on the channel",
    platform: "telegram",
  },
  "tiktok:followers": { bucket: "crew", metricLabel: "followers", platform: "tiktok" },
  "tiktok:likes": { bucket: "reach", metricLabel: "likes", platform: "tiktok" },
  "tiktok:views": { bucket: "reach", metricLabel: "views", platform: "tiktok" },
  "twitch:followers": { bucket: "crew", metricLabel: "followers", platform: "twitch" },
  "youtube:subscribers": { bucket: "crew", metricLabel: "subscribers", platform: "youtube" },
  "youtube:views": { bucket: "reach", metricLabel: "views", platform: "youtube" },
};

type ReachPoint = { at: string; value: number };

type ReachRow = {
  bucket: Bucket;
  key: string;
  metricLabel: string;
  platform: PlatformDef;
  points: ReachPoint[];
};

function toRow(series: PlatformStatSeries): ReachRow | undefined {
  const key = `${series.platform}:${series.metric}`;
  const meta = METRIC_META[key];
  const platform = meta ? PLATFORM_BY_SLUG.get(meta.platform) : undefined;

  if (!meta || !platform || series.points.length === 0) {
    return undefined;
  }

  const adjust = (value: number) => (meta.includesPostingBot ? Math.max(0, value - 1) : value);

  return {
    bucket: meta.bucket,
    key,
    metricLabel: meta.metricLabel,
    platform,
    points: series.points.map((point) => ({ at: point.capturedAt, value: adjust(point.value) })),
  };
}

function orderRows(rows: ReachRow[]): ReachRow[] {
  return [...rows].sort((a, b) => {
    const byPlatform = a.platform.label.localeCompare(b.platform.label);

    return byPlatform === 0 ? a.metricLabel.localeCompare(b.metricLabel) : byPlatform;
  });
}

const numberFormatter = new Intl.NumberFormat("en-US");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const formatValue = (value: number) => numberFormatter.format(value);
const formatDate = (value: string) => dateFormatter.format(new Date(value));

const latestOf = (row: ReachRow) => row.points[row.points.length - 1]?.value ?? 0;

function windowDelta(points: ReachPoint[]): string | undefined {
  const first = points[0];
  const last = points[points.length - 1];

  if (!first || !last || points.length < 2 || last.value === first.value) {
    return undefined;
  }

  const delta = last.value - first.value;

  return delta > 0 ? `+${formatValue(delta)}` : `−${formatValue(Math.abs(delta))}`;
}

const PERIODS = [
  { days: 7, label: "7D" },
  { days: 30, label: "30D" },
  { days: 90, label: "90D" },
] as const;

type PeriodDays = (typeof PERIODS)[number]["days"];

function slicePoints(points: ReachPoint[], days: PeriodDays): ReachPoint[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sliced = points.filter((point) => new Date(point.at).getTime() >= cutoff);

  return sliced.length > 0 ? sliced : points.slice(-1);
}

const CHART_W = 800;
const CHART_H = 220;
const CHART_PAD_Y = 18;

type ChartSeries = { label: string; points: ReachPoint[] };

const chartGeometry = (points: ReachPoint[]) =>
  sharedChartGeometry(points, { height: CHART_H, padY: CHART_PAD_Y, width: CHART_W });

function ReachChart({ series }: { series: ChartSeries }) {
  const points = series.points;
  const single = points.length < 2;
  const latest = points[points.length - 1];
  const geometry = chartGeometry(points);

  return (
    <figure aria-label={`${series.label} over time`} className="m-0">
      <div className="relative">
        <svg
          aria-hidden
          className="h-44 w-full text-foreground/80 sm:h-56"
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
              {formatValue(geometry.max)}
            </span>
            {geometry.min !== geometry.max ? (
              <span className="pointer-events-none absolute bottom-0 left-0 text-[11px] tabular-nums text-muted-foreground">
                {formatValue(geometry.min)}
              </span>
            ) : undefined}
          </>
        )}
      </div>

      <figcaption className="mt-2 flex items-baseline justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        {single && latest ? (
          <span>
            {series.label}: {formatValue(latest.value)} · first reading {formatDate(latest.at)}. The
            line draws itself from here.
          </span>
        ) : (
          <>
            <span>{points[0] ? formatDate(points[0].at) : ""}</span>
            <span className="text-foreground/80">
              {series.label} · {latest ? formatValue(latest.value) : ""} now
            </span>
          </>
        )}
      </figcaption>
    </figure>
  );
}

const TILE_SPARK_W = 100;
const TILE_SPARK_H = 28;

function TileSpark({ area, points }: { area: boolean; points: ReachPoint[] }) {
  if (points.length < 2) {
    return undefined;
  }

  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const usable = TILE_SPARK_H - 6;

  const coords = values.map((value, index) => ({
    x: (index / (values.length - 1)) * TILE_SPARK_W,
    y: span === 0 ? TILE_SPARK_H / 2 : 3 + (1 - (value - min) / span) * usable,
  }));
  const line = coords.map((coord) => `${coord.x},${coord.y}`).join(" ");
  const areaPath = `M0,${TILE_SPARK_H} L${coords.map((c) => `${c.x},${c.y}`).join(" L")} L${TILE_SPARK_W},${TILE_SPARK_H} Z`;

  return (
    <svg
      aria-hidden
      className="h-7 w-full text-muted-foreground/50"
      preserveAspectRatio="none"
      viewBox={`0 0 ${TILE_SPARK_W} ${TILE_SPARK_H}`}
    >
      {area ? <path className="fill-foreground/[0.05]" d={areaPath} /> : undefined}
      <polyline
        fill="none"
        points={line}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function PlatformMark({ className, platform }: { className?: string; platform: PlatformDef }) {
  return platform.icon ? (
    <BrandIcon className={className} icon={platform.icon} />
  ) : (
    <PaperPlaneTiltIcon aria-hidden className={className} />
  );
}

function StatTile({ area, row }: { area: boolean; row: ReachRow }) {
  const latest = latestOf(row);
  const delta = windowDelta(row.points);
  const single = row.points.length < 2;

  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <PlatformMark className="size-3.5 shrink-0" platform={row.platform} />
        <span className="truncate text-xs">
          {row.platform.label} · {row.metricLabel}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="text-2xl font-medium tabular-nums text-foreground">
          {formatValue(latest)}
        </span>
        {delta ? (
          <span className="text-xs tabular-nums text-muted-foreground">{delta}</span>
        ) : undefined}
      </div>

      <div className="mt-3">
        {single ? (
          <p className="text-[11px] text-muted-foreground">
            first reading {formatDate(row.points[0]?.at ?? "")}
          </p>
        ) : (
          <TileSpark area={area} points={row.points} />
        )}
      </div>
    </div>
  );
}

function HangarRow({ row }: { row: ReachRow }) {
  const latest = latestOf(row);
  const delta = windowDelta(row.points);

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <PlatformMark className="size-3.5 shrink-0" platform={row.platform} />
        <span className="truncate text-xs">
          {row.platform.label} · {row.metricLabel}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        {delta ? (
          <span className="text-xs tabular-nums text-muted-foreground">{delta}</span>
        ) : undefined}
        <span className="text-sm font-medium tabular-nums text-foreground">
          {formatValue(latest)}
        </span>
      </div>
    </div>
  );
}

const SECTION_HEADING_CLASS =
  "flex items-baseline justify-between border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground";

function LaneHeading({ detail, label }: { detail?: string; label: string }) {
  return (
    <h2 className={SECTION_HEADING_CLASS}>
      {label}
      {detail ? (
        <span className="text-xs font-normal normal-case tracking-normal text-muted-foreground tabular-nums">
          {detail}
        </span>
      ) : undefined}
    </h2>
  );
}

const fetchReach = createServerFn({ method: "GET" }).handler(
  (): Promise<PlatformStatsView> => listPlatformStats(),
);

function crewSeries(rows: ReachRow[]): ReachPoint[] {
  const byDay = new Map<string, number>();

  for (const row of rows) {
    for (const point of row.points) {
      const day = point.at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + point.value);
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ at: `${day}T00:00:00.000Z`, value }));
}

const title = "Fluncle's reach across every platform";
const description =
  "How far the findings have carried, platform by platform, and the crew aboard over time.";

function reachHead({ loaderData }: { loaderData?: PlatformStatsView }) {
  const counters = (loaderData?.series ?? []).flatMap((series) => {
    const key = `${series.platform}:${series.metric}`;
    const meta = METRIC_META[key];
    const platform = meta ? PLATFORM_BY_SLUG.get(meta.platform) : undefined;

    if (!meta || !platform || meta.bucket !== "crew") {
      return [];
    }

    const value = meta.includesPostingBot ? Math.max(0, series.latest - 1) : series.latest;

    return [
      {
        "@type": "InteractionCounter",
        interactionService: { "@type": "WebSite", name: platform.label },
        interactionType: { "@type": "FollowAction" },
        userInteractionCount: value,
      },
    ];
  });

  const entity = {
    "@context": "https://schema.org",
    "@id": fluncleEntityId,
    "@type": "Person",
    description: fluncleDescription,
    image: `${siteUrl}/fluncle-cover.png`,
    ...(counters.length > 0 ? { interactionStatistic: counters } : {}),
    name: "Fluncle",
    url: siteUrl,
  };

  return {
    links: [{ href: `${siteUrl}/reach`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/reach`, property: "og:url" },
    ],
    scripts: [jsonLdScript(entity)],
  };
}

type ReachSearch = { platform?: string };

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/reach")({
  validateSearch: (search: Record<string, unknown>): ReachSearch => {
    const platform = typeof search.platform === "string" ? search.platform : undefined;

    return PLATFORM_BY_SLUG.has(platform ?? "") ? { platform } : {};
  },
  loader: () => fetchReach(),
  head: reachHead,
  component: ReachPage,
});

function ReachPage() {
  const { series } = Route.useLoaderData();
  const { platform: activeSlug } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const [periodDays, setPeriodDays] = useState<PeriodDays>(90);
  const [chartKey, setChartKey] = useState<string | undefined>(undefined);

  const allRows = useMemo(
    () =>
      orderRows(
        series.flatMap((one) => {
          const row = toRow(one);

          return row ? [row] : [];
        }),
      ),
    [series],
  );

  const rows = useMemo(
    () =>
      allRows.map((row) => ({
        ...row,
        points: slicePoints(row.points, periodDays),
      })),
    [allRows, periodDays],
  );

  const scoped = activeSlug ? rows.filter((row) => row.platform.slug === activeSlug) : rows;
  const crew = scoped.filter((row) => row.bucket === "crew");
  const reach = scoped.filter((row) => row.bucket === "reach");
  const hangar = scoped.filter((row) => row.bucket === "hangar");

  const crewTotal = crew.reduce((sum, row) => sum + latestOf(row), 0);
  const presentSlugs = new Set(allRows.map((row) => row.platform.slug));

  const chartOptions = useMemo<(ChartSeries & { key: string })[]>(() => {
    if (!activeSlug) {
      return crew.length > 0
        ? [{ key: "crew-total", label: "The crew, aboard", points: crewSeries(crew) }]
        : scoped.slice(0, 1).map((row) => ({
            key: row.key,
            label: `${row.platform.label} ${row.metricLabel}`,
            points: row.points,
          }));
    }

    return scoped.map((row) => ({
      key: row.key,
      label: `${row.platform.label} ${row.metricLabel}`,
      points: row.points,
    }));
  }, [activeSlug, crew, scoped]);

  const activeChart = chartOptions.find((option) => option.key === chartKey) ?? chartOptions[0];

  const selectPlatform = (slug: string | undefined) => {
    setChartKey(undefined);
    void navigate({
      replace: true,
      search: slug ? { platform: slug } : {},
    });
  };

  const chipClass = (active: boolean) =>
    `inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-200 ${
      active
        ? "border-foreground/50 bg-foreground/10 text-foreground"
        : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
    }`;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-plate--console text-foreground">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Reach</h1>
          <p className="log-index-intro">
            {crewTotal > 0 && !activeSlug
              ? `${formatValue(crewTotal)} of you aboard across the Galaxy so far. This is the console where my probes report home.`
              : "This is the console where my probes report home: every surface I've reached, and how far it's carried."}
          </p>
        </header>

        {allRows.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            No readings back yet. Check back in a moment.
          </p>
        ) : (
          <div className="space-y-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div
                aria-label="Filter by platform"
                className="-mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1 py-1"
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a rail of filter buttons, not form fields; <fieldset>'s min-inline-size would break the horizontal scroll.
                role="group"
              >
                <button
                  className={chipClass(!activeSlug)}
                  onClick={() => selectPlatform(undefined)}
                  type="button"
                >
                  All
                </button>
                {PLATFORMS.filter((p) => presentSlugs.has(p.slug))
                  .sort((a, b) => a.label.localeCompare(b.label))
                  .map((p) => (
                    <button
                      className={chipClass(activeSlug === p.slug)}
                      key={p.slug}
                      onClick={() => selectPlatform(activeSlug === p.slug ? undefined : p.slug)}
                      type="button"
                    >
                      <PlatformMark className="size-3" platform={p} />
                      {p.label}
                    </button>
                  ))}
              </div>

              {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a row of period buttons, not form fields; <fieldset> would name itself from a <legend> this row has no room for. */}
              <div aria-label="Period" className="flex gap-1.5" role="group">
                {PERIODS.map((period) => (
                  <button
                    className={chipClass(periodDays === period.days)}
                    key={period.days}
                    onClick={() => setPeriodDays(period.days)}
                    type="button"
                  >
                    {period.label}
                  </button>
                ))}
              </div>
            </div>

            {activeChart ? (
              <section aria-label="Primary chart">
                {chartOptions.length > 1 ? (
                  <div className="mb-4 flex flex-wrap gap-1.5">
                    {chartOptions.map((option) => {
                      const active =
                        option.key === chartKey ||
                        (chartKey === undefined && option === chartOptions[0]);

                      return (
                        <button
                          className={chipClass(active)}
                          key={option.key}
                          onClick={() => setChartKey(option.key)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                ) : undefined}
                <ReachChart series={activeChart} />
              </section>
            ) : undefined}

            {crew.length > 0 ? (
              <section aria-label="The crew" className="space-y-4">
                <LaneHeading detail={`${formatValue(crewTotal)} aboard`} label="The crew" />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {crew.map((row) => (
                    <StatTile area key={row.key} row={row} />
                  ))}
                </div>
              </section>
            ) : undefined}

            {reach.length > 0 ? (
              <section aria-label="The reach" className="space-y-4">
                <LaneHeading
                  detail="I don't add these up: a view isn't a listen"
                  label="The reach"
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {reach.map((row) => (
                    <StatTile area={false} key={row.key} row={row} />
                  ))}
                </div>
              </section>
            ) : undefined}

            {hangar.length > 0 ? (
              <section aria-label="The hangar" className="space-y-2">
                <LaneHeading detail="the developer bench" label="The hangar" />
                <div className="divide-y divide-border/50">
                  {hangar.map((row) => (
                    <HangarRow key={row.key} row={row} />
                  ))}
                </div>
              </section>
            ) : undefined}
          </div>
        )}

        <footer className="log-plate-footer">
          <Link to="/status">System status</Link>
          <Link to="/findings">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
