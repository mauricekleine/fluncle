import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siteUrl } from "@/lib/fluncle-links";
import {
  listPlatformStats,
  type PlatformStatSeries,
  type PlatformStatsView,
} from "@/lib/server/platform-stats";

// The PUBLIC reach page — Fluncle's numbers across every platform, over time. No
// admin guard: every number here is already public on its own platform, so the read
// is anonymous by design (the `list_platform_stats` contract op is public tier).
//
// This page is deliberately NOT a SaaS dashboard and carries NO big-number KPI hero
// (DESIGN.md's explicit veto: "There are no heroes, no metrics, no pitch"). It reads
// as a LOGBOOK, the escape /status already demonstrated: the log-plate chrome, a quiet
// row per (platform, metric), a small muted sparkline of its series, the current
// value in the reading register (tabular cream, never oversized display type), and
// Eclipse Gold spent on nothing but the freshest snapshot tick (The One Sun Rule).
//
// It is loader-only presentation (public-route law, AGENTS.md): a GET server fn calls
// `listPlatformStats()` directly (server-side, not over HTTP), the loader calls it,
// the component reads `Route.useLoaderData()`. No react-query.

// ── The page taxonomy ────────────────────────────────────────────────────────
//
// How each raw (platform, metric) the collector stored maps into the page's two
// honest buckets (the stats-page spike), keyed `${platform}:${metric}`. The server
// stores raw rows and takes NO view on grouping; the grouping is a PAGE decision, so
// it lives here.
//
//   - The crew  — audience: people who opted in. Followers, subscribers, saves,
//                 stars, ratings. Each is one person who chose to keep Fluncle
//                 around, so a cross-surface sum is honest.
//   - The reach — consumption events. Plays, listens, scrobbles, views, downloads.
//                 These do NOT cross-sum (a view isn't a listen), so the page never
//                 adds them into one number. (Not "the signal": signal(s)-as-identity
//                 is banned vocabulary, the retired radio metaphor — VOICE.md.)
//
// A (platform, metric) with no entry here is intentionally NOT surfaced — Fluncle's
// own OUTPUT counts (mixcloud `uploads`, bluesky `posts`, lastfm `loved_tracks`) are
// neither the crew growing nor how far a finding reached, so they stay off this page
// rather than pad a bucket. The raw rows still exist; this map just doesn't draw them.
type Bucket = "crew" | "signal";

type MetricMeta = {
  bucket: Bucket;
  // `botMinusOne`: Telegram's `getChatMemberCount` counts the posting bot itself. The
  // DATA stays raw (honesty lives in the ledger); the DISPLAY subtracts the bot, so
  // the page shows humans aboard, not humans + the bot.
  botMinusOne?: boolean;
  metricLabel: string;
  platformLabel: string;
};

const METRIC_META: Record<string, MetricMeta> = {
  "appstore:rating_count": { bucket: "crew", metricLabel: "ratings", platformLabel: "App Store" },
  "bluesky:followers": { bucket: "crew", metricLabel: "followers", platformLabel: "Bluesky" },
  "github:stars": { bucket: "crew", metricLabel: "stars on the repo", platformLabel: "GitHub" },
  "lastfm:scrobbles": { bucket: "signal", metricLabel: "scrobbles", platformLabel: "Last.fm" },
  "mixcloud:followers": { bucket: "crew", metricLabel: "followers", platformLabel: "Mixcloud" },
  "mixcloud:listens": { bucket: "signal", metricLabel: "total listens", platformLabel: "Mixcloud" },
  "newsletter:audience": {
    bucket: "crew",
    metricLabel: "aboard the mothership",
    platformLabel: "Newsletter",
  },
  "npm:downloads_weekly": {
    bucket: "signal",
    metricLabel: "CLI downloads, last week",
    platformLabel: "npm",
  },
  "spotify_playlist:playlist_saves": {
    bucket: "crew",
    metricLabel: "playlist saves",
    platformLabel: "Spotify",
  },
  "telegram:audience": {
    botMinusOne: true,
    bucket: "crew",
    metricLabel: "on the channel",
    platformLabel: "Telegram",
  },
  "youtube:subscribers": {
    bucket: "crew",
    metricLabel: "subscribers",
    platformLabel: "YouTube",
  },
  "youtube:views": { bucket: "signal", metricLabel: "views", platformLabel: "YouTube" },
};

// A stable display order within each bucket (the loudest surfaces first); an
// unmapped-but-somehow-present platform would sort last, alphabetically.
const PLATFORM_ORDER = [
  "Spotify",
  "YouTube",
  "Mixcloud",
  "Telegram",
  "Newsletter",
  "Bluesky",
  "Last.fm",
  "GitHub",
  "App Store",
  "npm",
];

// One row the page renders: a (platform, metric) series resolved through the map, its
// values already display-adjusted (Telegram's bot removed) and in chronological order.
type ReachRow = {
  bucket: Bucket;
  firstAt: string;
  key: string;
  latestAt: string;
  metricLabel: string;
  platformLabel: string;
  values: number[];
};

function toRow(series: PlatformStatSeries): ReachRow | undefined {
  const key = `${series.platform}:${series.metric}`;
  const meta = METRIC_META[key];

  if (!meta) {
    return undefined;
  }

  const adjust = (value: number) => (meta.botMinusOne ? Math.max(0, value - 1) : value);
  const points = series.points;
  const first = points[0];
  const last = points[points.length - 1];

  if (!first || !last) {
    return undefined;
  }

  return {
    bucket: meta.bucket,
    firstAt: first.capturedAt,
    key,
    latestAt: last.capturedAt,
    metricLabel: meta.metricLabel,
    platformLabel: meta.platformLabel,
    values: points.map((point) => adjust(point.value)),
  };
}

function orderRows(rows: ReachRow[]): ReachRow[] {
  return [...rows].sort((a, b) => {
    const ai = PLATFORM_ORDER.indexOf(a.platformLabel);
    const bi = PLATFORM_ORDER.indexOf(b.platformLabel);
    const ar = ai === -1 ? PLATFORM_ORDER.length : ai;
    const br = bi === -1 ? PLATFORM_ORDER.length : bi;

    if (ar !== br) {
      return ar - br;
    }

    return a.platformLabel === b.platformLabel
      ? a.metricLabel.localeCompare(b.metricLabel)
      : a.platformLabel.localeCompare(b.platformLabel);
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────

const numberFormatter = new Intl.NumberFormat("en-US");

// A fixed, locale-stable "Jul 13" for the series' first/latest dates, UTC-pinned so
// the server render matches hydration exactly (the /status + @/lib/format precedent).
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function formatValue(value: number): string {
  return numberFormatter.format(value);
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

// The growth across the window, quiet: "+12" / "−3" (a real minus, tabular). This is
// the crew growing / the reach spreading — the point of the page — but stated once and
// left alone (VOICE.md's Dry Rule), never a hero delta. Null when nothing moved or the
// series has a single point.
function windowDelta(values: number[]): string | undefined {
  const first = values[0];
  const last = values[values.length - 1];

  if (first === undefined || last === undefined || values.length < 2) {
    return undefined;
  }

  const delta = last - first;

  if (delta === 0) {
    return undefined;
  }

  return delta > 0 ? `+${formatValue(delta)}` : `−${formatValue(Math.abs(delta))}`;
}

// ── The sparkline ────────────────────────────────────────────────────────────
//
// A small muted trend line of the series — the UptimeBar idiom (DESIGN.md), an inline
// SVG polyline in the calm dim-neutral (`muted-foreground`), never gold: the trend is
// quiet by construction. The One Sun is spent on the single live accent — the freshest
// snapshot tick, an Eclipse-Gold dot at the series' leading edge. The viewBox stretches
// to the row width; a non-scaling stroke keeps the line a hairline at any width. A
// single-point series has no line to draw (day-one reality), so the row skips the
// sparkline and says so instead (see PlatformRow).
const SPARK_H = 32;
const SPARK_W = 100;
const SPARK_PAD = 4;

function sparkPoints(values: number[]): { last: { x: number; y: number }; polyline: string } {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const usable = SPARK_H - SPARK_PAD * 2;

  const coords = values.map((value, index) => {
    const x = values.length === 1 ? SPARK_W : (index / (values.length - 1)) * SPARK_W;
    // Flat series (span 0) sits on the mid-line; otherwise a higher value sits higher
    // (smaller y). Newest value at the right edge.
    const y = span === 0 ? SPARK_H / 2 : SPARK_PAD + (1 - (value - min) / span) * usable;

    return { x, y };
  });

  const last = coords[coords.length - 1] ?? { x: SPARK_W, y: SPARK_H / 2 };

  return { last, polyline: coords.map((coord) => `${coord.x},${coord.y}`).join(" ") };
}

function Sparkline({ values }: { values: number[] }) {
  const { last, polyline } = sparkPoints(values);

  return (
    <svg
      aria-hidden
      className="h-8 w-full overflow-visible text-muted-foreground/45"
      preserveAspectRatio="none"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
    >
      <polyline
        fill="none"
        points={polyline}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {/* The freshest snapshot: the one live accent, Eclipse Gold. A gentle motion-safe
          pulse reads as a living signal, not wallpaper; reduced-motion gets a steady dot. */}
      <circle
        className="fill-primary motion-safe:animate-pulse"
        cx={last.x}
        cy={last.y}
        r={2.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ── One platform row ─────────────────────────────────────────────────────────
//
// The masthead (platform label + the current value, right-aligned), a terse metric
// subtitle with the quiet window delta, the sparkline, and the span footer (first
// snapshot date · now). Mirrors /status's ServiceRow so the two numbers pages read at
// one grammar.
function PlatformRow({ row }: { row: ReachRow }) {
  const latest = row.values[row.values.length - 1] ?? 0;
  const delta = windowDelta(row.values);
  const singlePoint = row.values.length < 2;

  return (
    <article className="py-6 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-medium text-foreground">{row.platformLabel}</h3>
        {/* The datum, in the reading register: tabular cream, never gold, never display
            type. The eye reads it; it doesn't get shouted at. */}
        <span className="text-sm tabular-nums text-foreground">{formatValue(latest)}</span>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        {row.metricLabel}
        {delta ? <span className="tabular-nums"> · {delta}</span> : undefined}
      </p>

      {singlePoint ? (
        <p className="mt-4 text-xs text-muted-foreground">
          First snapshot logged {formatDate(row.latestAt)}.
        </p>
      ) : (
        <>
          <div className="mt-4">
            <Sparkline values={row.values} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
            <span>{formatDate(row.firstAt)}</span>
            <span className="text-foreground/80">now</span>
          </div>
        </>
      )}
    </article>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

// The section heading grammar, shared with /status: a quiet uppercase label over a
// hairline rule, the row count at the far end.
const SECTION_HEADING_CLASS =
  "mb-4 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground";

function ReachSection({
  descriptor,
  label,
  rows,
}: {
  descriptor: string;
  label: string;
  rows: ReachRow[];
}) {
  if (rows.length === 0) {
    return undefined;
  }

  return (
    <section aria-label={label}>
      <h2 className={`${SECTION_HEADING_CLASS} flex items-baseline justify-between`}>
        {label}
        <span className="text-xs font-normal normal-case tracking-normal text-muted-foreground tabular-nums">
          {rows.length}
        </span>
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">{descriptor}</p>
      <div className="divide-y divide-border/50">
        {rows.map((row) => (
          <PlatformRow key={row.key} row={row} />
        ))}
      </div>
    </section>
  );
}

const fetchReach = createServerFn({ method: "GET" }).handler(
  (): Promise<PlatformStatsView> => listPlatformStats(),
);

const title = "Reach · Fluncle";
// Machine-facing meta is honestly-plain third person (VOICE.md's Narrator rule); the
// first-person voice lives in the on-page masthead line.
const description =
  "Fluncle's numbers across every platform, over time: the crew aboard, and how far the findings have reached.";

function reachHead() {
  return {
    links: [{ href: `${siteUrl}/reach`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/reach`, property: "og:url" },
    ],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/reach")({
  loader: () => fetchReach(),
  head: reachHead,
  component: ReachPage,
});

function ReachPage() {
  const { series } = Route.useLoaderData();

  const rows = series.flatMap((one) => {
    const row = toRow(one);

    return row ? [row] : [];
  });
  const crew = orderRows(rows.filter((row) => row.bucket === "crew"));
  const signal = orderRows(rows.filter((row) => row.bucket === "signal"));

  // The crew total: a sum ONLY of the audience metrics (each is one person who opted
  // in, so the sum is honest — the spike's rule). The reach bucket is never summed.
  const crewTotal = crew.reduce((sum, row) => sum + (row.values[row.values.length - 1] ?? 0), 0);

  return (
    <main className="log-plate-stage">
      <article className="log-plate text-foreground">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Reach</h1>
          <p className="log-index-intro">
            {crewTotal > 0
              ? `${formatValue(crewTotal)} of you aboard across the Galaxy so far. Here's every surface I've reached, and how far it's carried.`
              : "Every surface I've reached, and how far it's carried. The first numbers are landing now."}
          </p>
        </header>

        {rows.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            No numbers back yet. Check back in a moment.
          </p>
        ) : (
          <div className="space-y-8">
            <ReachSection
              descriptor="Everyone who kept me around out here: followers, subscribers, saves, stars."
              label="The crew"
              rows={crew}
            />
            <ReachSection
              descriptor="How far the findings have carried: listens, views, scrobbles, downloads. A view isn't a listen, so I don't add them up."
              label="The reach"
              rows={signal}
            />
          </div>
        )}

        <footer className="log-plate-footer">
          <Link to="/status">System status</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
