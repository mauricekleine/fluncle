import { type ChartGeometry, chartGeometry as computeChartGeometry } from "@/lib/chart-geometry";
import {
  type CaptureBacklog,
  type CatalogueSnapshotRow,
  type FunnelLiveQueues,
  type FunnelStages,
} from "@/lib/server/funnel";

export type StageKey = keyof FunnelStages;

export type StageLink =
  | { lens: "capture" | "ear"; to: "/admin/catalogue" }
  | { to: "/admin/findings" };

export type StageQueueSplit = { awaitingAudio: number; ready: number };

type StageDef = {
  key: StageKey;
  label: string;
  link: StageLink;

  queued?: (live: StageLiveCounts) => number;

  queuedSplit?: (live: StageLiveCounts) => StageQueueSplit;
};

export type StageLiveCounts = { captureBacklog: CaptureBacklog; queues: FunnelLiveQueues };

const STAGE_DEFS: StageDef[] = [
  { key: "crawled", label: "Crawled", link: { lens: "ear", to: "/admin/catalogue" } },
  {
    key: "captured",
    label: "Captured",
    link: { lens: "capture", to: "/admin/catalogue" },
    queued: (live) => live.captureBacklog.authorized,
  },
  {
    key: "analyzed",
    label: "Analyzed",
    link: { lens: "ear", to: "/admin/catalogue" },
    queued: (live) => live.queues.analyzeQueue,
  },
  {
    key: "embedded",
    label: "Embedded",
    link: { lens: "ear", to: "/admin/catalogue" },
    queued: (live) => live.queues.embedQueue,
  },
  {
    key: "anchored",
    label: "Anchored",
    link: { lens: "ear", to: "/admin/catalogue" },

    queuedSplit: (live) => ({
      awaitingAudio: live.queues.anchorQueueAwaitingAudio,
      ready: live.queues.anchorQueueReady,
    }),
  },
  { key: "recEligible", label: "Rec-eligible", link: { lens: "ear", to: "/admin/catalogue" } },
  { key: "certified", label: "Certified", link: { to: "/admin/findings" } },
];

export type FunnelStageBar = {
  key: StageKey;
  label: string;
  link: StageLink;

  queued: number | undefined;

  queuedSplit: StageQueueSplit | undefined;
  total: number;

  widthPct: number;
};

export function stageBars(stages: FunnelStages, live: StageLiveCounts): FunnelStageBar[] {
  const maxTotal = STAGE_DEFS.reduce((max, def) => Math.max(max, stages[def.key]), 0);

  return STAGE_DEFS.map((def) => {
    const total = stages[def.key];

    return {
      key: def.key,
      label: def.label,
      link: def.link,
      queued: def.queued ? def.queued(live) : undefined,
      queuedSplit: def.queuedSplit ? def.queuedSplit(live) : undefined,
      total,
      widthPct: maxTotal === 0 ? 0 : (total / maxTotal) * 100,
    };
  }).sort((a, b) => b.total - a.total);
}

export type StageThroughput = { delta: number; key: StageKey; label: string };

export type DailyThroughput = {
  from: string;
  stages: StageThroughput[];

  to: string;
};

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

export type GrowthPoint = { at: string; value: number };

export function growthPoints(series: CatalogueSnapshotRow[], key: StageKey): GrowthPoint[] {
  return series.map((row) => ({ at: row.day, value: row[key] }));
}

export const CHART_W = 800;
export const CHART_H = 160;
const CHART_PAD_Y = 14;

export function chartGeometry(points: GrowthPoint[]): ChartGeometry {
  return computeChartGeometry(points, { height: CHART_H, padY: CHART_PAD_Y, width: CHART_W });
}
