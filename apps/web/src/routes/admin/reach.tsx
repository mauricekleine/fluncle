import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { TiktokIcon, YoutubeIcon } from "@/components/platform-icons";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  getSocialMetricsBoard,
  type ReachPivot,
  type ReachPostRow,
  type SocialMetricsBoard,
} from "@/lib/server/reach-board";

// The `/admin/reach` station — the pivot board over the append-only social-metrics ledger
// (reach-board.ts). It answers the operator's two working questions: which posts are moving RIGHT
// NOW (day-over-day view velocity, not cumulative vanity — the default sort), and which creative
// axes actually perform (platform × video-structure and platform × plate-subject, with small-n
// counts so a one-post cell never reads as a trend).
//
// ── DATA FLOW ─────────────────────────────────────────────────────────────────────────────────
// The admin loader-seeded react-query hybrid (AGENTS.md): a GET server fn reads
// `getSocialMetricsBoard` SERVER-SIDE in-process (the browser-admin pattern — no oRPC client, the
// `/admin/funnel` precedent), the loader seeds it, and a focus-refetching `useQuery` keeps the
// numbers honest on tab-back. The whole reduction + ranking is in SQL; the page only draws.
//
// The register is plain operator English (the admin law): no fiction, just the numbers and what
// they measure.

const REACH_KEY = ["admin", "reach"] as const;

const numberFormatter = new Intl.NumberFormat("en-US");
const formatCount = (value: number) => numberFormatter.format(Math.round(value));

// UTC-pinned "Jul 18" so the server render matches hydration exactly (the /admin/funnel precedent).
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const formatDay = (day: string) => dateFormatter.format(new Date(`${day}T00:00:00.000Z`));

/** A per-day velocity, signed: "+225 / day", "−40 / day", or "flat". */
function formatVelocity(perDay: number): string {
  if (perDay > 0) {
    return `+${formatCount(perDay)} / day`;
  }

  if (perDay < 0) {
    return `−${formatCount(Math.abs(perDay))} / day`;
  }

  return "flat";
}

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// The one-call read, server-side + in-process (no HTTP, no CORS), re-checking the grant. The
// loader and the focus-refetch both land here.
const fetchReach = createServerFn({ method: "GET" }).handler(
  async (): Promise<SocialMetricsBoard> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return getSocialMetricsBoard();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/reach")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchReach(),
  component: ReachPage,
});

function ReachPage() {
  const initial = Route.useLoaderData();
  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchReach(),
    queryKey: REACH_KEY,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const subtitle =
    data.totalPosts === 0
      ? "No posts measured yet"
      : `${formatCount(data.totalPosts)} post series · last ${data.windowDays} days`;

  return (
    <AdminShell subtitle={subtitle} title="Reach">
      <div className="space-y-8 p-4 sm:p-5">
        {data.totalPosts === 0 ? (
          <EmptyReach />
        ) : (
          <>
            <MovingBand posts={data.posts} />
            <PivotBand
              intro="Median and mean views per structure, per platform. Small-n cells are labelled — one post is not a trend."
              pivot={data.pivots.structure}
              title="Structure"
            />
            <PivotBand
              intro="The same read across plate subjects."
              pivot={data.pivots.plateSubject}
              title="Plate subject"
            />
          </>
        )}
      </div>
    </AdminShell>
  );
}

// ── The moving band ─────────────────────────────────────────────────────────────────────────
// Every measured post series, most-velocity first (the SQL sort). Each row: what it is, where it
// lives, its latest views + the sparkline, its day-over-day velocity, and the platform-specific
// tail (retention for youtube_analytics rows; likes/comments/shares for the rest).

function MovingBand({ posts }: { posts: ReachPostRow[] }) {
  return (
    <section aria-label="Moving now" className="space-y-3">
      <BandHeading>Moving now</BandHeading>
      <p className="text-xs text-muted-foreground">
        Every post series, fastest-growing first. Velocity is views gained per day since the last
        snapshot.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {posts.map((post) => (
          <li key={`${post.externalId}:${post.source}`}>
            <PostRow post={post} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PostRow({ post }: { post: ReachPostRow }) {
  const label = post.title ?? post.trackId;
  const artists = post.artists.length > 0 ? post.artists.join(", ") : undefined;
  const isYouTubeAnalytics = post.source === "youtube_analytics";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <PlatformGlyph platform={post.platform} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <SourceChip source={post.source} />
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {artists ? `${artists} · ` : ""}
            {post.publishedAt ? `posted ${formatDay(post.publishedAt.slice(0, 10))}` : "unposted"}
            {post.logId ? ` · ${post.logId}` : ""}
          </div>
        </div>
      </div>

      <Sparkline post={post} />

      <div className="w-24 shrink-0 text-right tabular-nums">
        <div className="text-sm font-medium">
          {post.views === null ? "—" : formatCount(post.views)}
        </div>
        <div className="text-xs text-muted-foreground">views</div>
      </div>

      <div className="w-28 shrink-0 text-right">
        <VelocityValue perDay={post.dailyViewVelocity} snapshots={post.snapshotCount} />
      </div>

      <div className="w-40 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {isYouTubeAnalytics ? <RetentionTail post={post} /> : <EngagementTail post={post} />}
      </div>
    </div>
  );
}

// Retention is the short-form signal — surfaced only for youtube_analytics rows, which are the
// only source that reports it.
function RetentionTail({ post }: { post: ReachPostRow }) {
  if (post.averageViewPercentage === null) {
    return <span>retention pending</span>;
  }

  const duration =
    post.averageViewDurationSeconds !== null ? ` · ${post.averageViewDurationSeconds}s avg` : "";

  return (
    <span>
      {post.averageViewPercentage.toFixed(0)}% watched{duration}
    </span>
  );
}

// The engagement tail for TikTok + Postiz rows: likes / comments / shares.
function EngagementTail({ post }: { post: ReachPostRow }) {
  const parts = [
    post.likes === null ? undefined : `${formatCount(post.likes)} likes`,
    post.comments === null ? undefined : `${formatCount(post.comments)} comments`,
    post.shares === null ? undefined : `${formatCount(post.shares)} shares`,
  ].filter((part): part is string => part !== undefined);

  return <span>{parts.length > 0 ? parts.join(" · ") : "no engagement yet"}</span>;
}

// The per-day velocity with a direction glyph. A lone snapshot has no velocity yet, so it says so
// rather than showing a fake zero (the honest short-data rule).
function VelocityValue({ perDay, snapshots }: { perDay: null | number; snapshots: number }) {
  if (perDay === null) {
    return (
      <span className="text-xs text-muted-foreground">{snapshots < 2 ? "one snapshot" : "—"}</span>
    );
  }

  const Glyph = perDay > 0 ? ArrowUpIcon : perDay < 0 ? ArrowDownIcon : undefined;

  return (
    <span className="flex items-center justify-end gap-1 text-sm font-medium tabular-nums">
      {Glyph ? (
        <Glyph
          aria-hidden="true"
          className={`size-3.5 ${perDay > 0 ? "text-primary" : "text-muted-foreground"}`}
          weight="bold"
        />
      ) : undefined}
      <span className={perDay === 0 ? "text-muted-foreground" : undefined}>
        {formatVelocity(perDay)}
      </span>
    </span>
  );
}

// A dependency-free inline-SVG sparkline of the post's view series. A single point draws one dot;
// a flat series draws a flat line. Decorative — the numbers beside it carry the meaning.
const SPARK_W = 88;
const SPARK_H = 28;

function Sparkline({ post }: { post: ReachPostRow }) {
  const points = post.series;

  if (points.length === 0) {
    return <span aria-hidden="true" className="hidden h-7 w-[88px] shrink-0 sm:block" />;
  }

  const values = points.map((point) => point.views);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = points.length > 1 ? SPARK_W / (points.length - 1) : 0;
  const pad = 2;
  const usableH = SPARK_H - pad * 2;

  const coords = points.map((point, index) => {
    const x = points.length > 1 ? index * stepX : SPARK_W / 2;
    const y = pad + (1 - (point.views - min) / span) * usableH;

    return { x, y };
  });

  const last = coords[coords.length - 1] ?? { x: SPARK_W / 2, y: SPARK_H / 2 };

  return (
    <svg
      aria-hidden="true"
      className="hidden h-7 w-[88px] shrink-0 text-foreground/70 sm:block"
      preserveAspectRatio="none"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
    >
      {coords.length > 1 ? (
        <polyline
          fill="none"
          points={coords.map((coord) => `${coord.x},${coord.y}`).join(" ")}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : undefined}
      {/* The One Sun: the live edge is the only gold. */}
      <circle
        className="fill-primary"
        cx={last.x}
        cy={last.y}
        r={2.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function PlatformGlyph({ platform }: { platform: ReachPostRow["platform"] }) {
  const className = "size-4 shrink-0 text-muted-foreground";

  return platform === "tiktok" ? (
    <TiktokIcon className={className} />
  ) : (
    <YoutubeIcon className={className} />
  );
}

// The snapshot source, as a quiet chip — which numbers these are (the ledger can carry two series
// for one post, so the source has to read).
function SourceChip({ source }: { source: ReachPostRow["source"] }) {
  const label =
    source === "youtube_analytics"
      ? "YouTube Analytics"
      : source === "tiktok_display"
        ? "TikTok"
        : source === "postiz"
          ? "Postiz"
          : "CSV";

  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}

// ── The pivot band ──────────────────────────────────────────────────────────────────────────
// One creative axis, its cells grouped by platform. Each cell: the axis value, its post count
// (the small-n signal), median + mean views, and mean retention where any post reported it.

function PivotBand({ intro, pivot, title }: { intro: string; pivot: ReachPivot; title: string }) {
  if (pivot.cells.length === 0) {
    return null;
  }

  return (
    <section aria-label={title} className="space-y-3">
      <BandHeading>{title}</BandHeading>
      <p className="text-xs text-muted-foreground">{intro}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Platform</th>
              <th className="py-2 pr-3 font-medium">{title}</th>
              <th className="py-2 pr-3 text-right font-medium">Posts</th>
              <th className="py-2 pr-3 text-right font-medium">Median views</th>
              <th className="py-2 pr-3 text-right font-medium">Mean views</th>
              <th className="py-2 text-right font-medium">Mean retention</th>
            </tr>
          </thead>
          <tbody>
            {pivot.cells.map((cell) => (
              <tr className="border-b border-border/60" key={`${cell.platform}:${cell.value}`}>
                <td className="py-2 pr-3 capitalize">{cell.platform}</td>
                <td className="py-2 pr-3">{cell.value}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  <span className={cell.count < 3 ? "text-muted-foreground" : undefined}>
                    {cell.count}
                    {cell.count < 3 ? " (small-n)" : ""}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCount(cell.medianViews)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(cell.meanViews)}</td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {cell.meanRetention === null
                    ? "—"
                    : `${cell.meanRetention.toFixed(0)}% (${cell.retentionCount})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BandHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-bold">{children}</h2>;
}

function EmptyReach() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      No post metrics yet. The daily snapshot fills this in once a video is published and measured.
    </div>
  );
}
