// THE FUNNEL — the client-side data shaping behind `/admin/funnel`
// (docs/rfcs/catalogue-funnel-rfc.md, U2). Pure functions only: they take the typed
// payload `get_funnel` returns and turn it into what the page draws — the proportional
// stage bars, the per-stage daily throughput, and the SVG chart geometry. Kept OUT of the
// route so the shaping is unit-testable in the node environment without React, and so the
// route imports its server read (`@/lib/server/funnel`) only inside a server fn.
//
// Every number here is a plain integer already computed server-side against the product's
// own predicates (funnel.ts § ONE SOURCE OF TRUTH). This module never counts — it only
// arranges, so the funnel can never tell a different story than the machine obeys.

import { type ChartGeometry, chartGeometry as computeChartGeometry } from "@/lib/chart-geometry";
import {
  type CatalogueSnapshotRow,
  type FunnelLiveQueues,
  type FunnelStages,
} from "@/lib/server/funnel";

/** A stage's key in the pipeline — the seven columns `FunnelStages` carries, in flow order. */
export type StageKey = keyof FunnelStages;

/**
 * The pipeline stages, left→right, crawl → certified. `queued` names the drain worklist
 * WAITING BEHIND a stage (the anchor/capture/analyze/embed sweeps' own backlogs); a stage
 * with no drain queue leaves it `undefined`. `to` (+ optional `search`) is the operating
 * surface a click opens, as a typed TanStack route target (client-side nav, not a reload).
 */

/**
 * The typed route target a stage links to. Each admin route carries its own required search
 * (Catalogue's `lens`, the Findings board's `mix`/`stage`), so the link names it explicitly —
 * the route renders it as a literal-`to` TanStack <Link> (client-side nav, keyboard-reachable).
 */
export type StageLink =
  | { lens: "capture" | "ear"; to: "/admin/catalogue" }
  | { to: "/admin/findings" };

/** The anchor stage's queued-behind, split into the actionable head and the metadata tail. */
export type StageQueueSplit = { awaitingAudio: number; ready: number };

type StageDef = {
  key: StageKey;
  label: string;
  link: StageLink;
  /** The queue depth waiting behind this stage, from the live queues (undefined = no queue). */
  queued?: (queues: FunnelLiveQueues) => number;
  /**
   * A two-population split of the queued-behind, for a stage where the single figure hides two
   * things that mean different things (the anchor worklist: embedded-and-ready vs awaiting audio).
   * When present the page renders this in place of the plain `queued` figure.
   */
  queuedSplit?: (queues: FunnelLiveQueues) => StageQueueSplit;
};

// The flow order and each stage's operating surface. The crawled rows and every mid-flight
// uncertified stage live on The Ear (`/admin/catalogue`, the default `ear` lens); the capture
// backlog has its own `capture` lens there; certified rows ARE findings, so certified opens
// the pipeline board.
const STAGE_DEFS: StageDef[] = [
  { key: "crawled", label: "Crawled", link: { lens: "ear", to: "/admin/catalogue" } },
  {
    key: "anchored",
    label: "Anchored",
    link: { lens: "ear", to: "/admin/catalogue" },
    // The anchor queue splits into the embedded head the sweep works now (ready) and the crawler
    // metadata still awaiting audio — two populations that mean different things, so the page shows
    // both rather than one folded figure. The split sums to `anchorQueueIsrc + anchorQueueNoIsrc`.
    queuedSplit: (q) => ({ awaitingAudio: q.anchorQueueAwaitingAudio, ready: q.anchorQueueReady }),
  },
  {
    key: "captured",
    label: "Captured",
    link: { lens: "capture", to: "/admin/catalogue" },
    queued: (q) => q.captureQueue,
  },
  {
    key: "analyzed",
    label: "Analyzed",
    link: { lens: "ear", to: "/admin/catalogue" },
    queued: (q) => q.analyzeQueue,
  },
  {
    key: "embedded",
    label: "Embedded",
    link: { lens: "ear", to: "/admin/catalogue" },
    queued: (q) => q.embedQueue,
  },
  { key: "recEligible", label: "Rec-eligible", link: { lens: "ear", to: "/admin/catalogue" } },
  { key: "certified", label: "Certified", link: { to: "/admin/findings" } },
];

/** One drawn stage: its counts, the operating surface it links to, and its proportional width. */
export type FunnelStageBar = {
  key: StageKey;
  label: string;
  link: StageLink;
  /** The queue waiting behind this stage, or undefined when the stage has no drain queue. */
  queued: number | undefined;
  /** The two-population split of the queued-behind (anchor only), or undefined for every other stage. */
  queuedSplit: StageQueueSplit | undefined;
  total: number;
  /** 0–100, proportional to the widest stage. 0 when every stage is empty (no divide-by-zero). */
  widthPct: number;
};

/**
 * The stage bars with honest proportional widths. Width is each stage's total as a fraction of
 * the WIDEST stage's total (so crawled — the biggest — reads full-width and the exits read as
 * the slivers they are). When every stage is empty the widest total is 0, so every width is 0 —
 * the guard that keeps an empty pipeline from dividing by zero.
 */
export function stageBars(stages: FunnelStages, queues: FunnelLiveQueues): FunnelStageBar[] {
  const maxTotal = STAGE_DEFS.reduce((max, def) => Math.max(max, stages[def.key]), 0);

  return STAGE_DEFS.map((def) => {
    const total = stages[def.key];

    return {
      key: def.key,
      label: def.label,
      link: def.link,
      queued: def.queued ? def.queued(queues) : undefined,
      queuedSplit: def.queuedSplit ? def.queuedSplit(queues) : undefined,
      total,
      widthPct: maxTotal === 0 ? 0 : (total / maxTotal) * 100,
    };
  });
}

/** One stage's movement between two consecutive snapshots — how many rows crossed that day. */
export type StageThroughput = { delta: number; key: StageKey; label: string };

/** A single day's throughput across every stage — the "what moved yesterday" glance. */
export type DailyThroughput = {
  /** The earlier snapshot's day (YYYY-MM-DD). */
  from: string;
  stages: StageThroughput[];
  /** The later snapshot's day (YYYY-MM-DD). */
  to: string;
};

/**
 * The per-stage daily throughput for the MOST RECENT consecutive pair of snapshots — today's
 * total minus yesterday's, per stage. Returns undefined when there are fewer than two snapshots
 * (a day's movement needs two readings; a single point has no delta — the honest short-data
 * case the page renders as a dry line, never a fabricated zero-baseline). The series is
 * oldest-first, so the last two rows are the newest pair.
 */
export function latestThroughput(series: CatalogueSnapshotRow[]): DailyThroughput | undefined {
  if (series.length < 2) {
    return undefined;
  }

  const previous = series[series.length - 2];
  const current = series[series.length - 1];
  if (!previous || !current) {
    return undefined;
  }

  return {
    from: previous.day,
    stages: STAGE_DEFS.map((def) => ({
      delta: current[def.key] - previous[def.key],
      key: def.key,
      label: def.label,
    })),
    to: current.day,
  };
}

/** One point on a growth line — a day and the value that stage/pool held that day. */
export type GrowthPoint = { at: string; value: number };

/**
 * A stage/pool's value across the whole series, oldest-first, as chartable points. `at` is the
 * snapshot day; the series is already day-ordered, so no re-sort is needed.
 */
export function growthPoints(series: CatalogueSnapshotRow[], key: StageKey): GrowthPoint[] {
  return series.map((row) => ({ at: row.day, value: row[key] }));
}

// ── SVG chart geometry ─────────────────────────────────────────────────────────────────
// The house line-chart shape (the public `/reach` console): a translucent area under a line,
// with min/max rails and one live-edge dot. The math lives in the SHARED `chart-geometry.ts`
// (one helper for /reach and the funnel); this wrapper pins it to the funnel's compact viewBox.

/** The funnel growth-chart viewBox (drawn with preserveAspectRatio="none", so it stretches). */
export const CHART_W = 800;
export const CHART_H = 160;
const CHART_PAD_Y = 14;

/** The funnel growth line's geometry — the shared helper at the funnel's viewBox dimensions. */
export function chartGeometry(points: GrowthPoint[]): ChartGeometry {
  return computeChartGeometry(points, { height: CHART_H, padY: CHART_PAD_Y, width: CHART_W });
}
