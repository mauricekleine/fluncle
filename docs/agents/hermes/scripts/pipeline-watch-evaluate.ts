import { cronStaleBudgetMs } from "./cron-freshness";

export type Stage =
  | "crawl"
  | "anchor"
  | "capture"
  | "analyze"
  | "embed"
  | "isrc-recovery"
  | "funnel-snapshot";
export type StageState =
  | "healthy"
  | "scheduled_pause"
  | "budget_closed"
  | "stalled"
  | "degraded"
  | "measurement_unavailable";
export type Marker = { at: number; summary: Record<string, unknown> };
export type StageVerdict = {
  backlog: number | null;
  cause: string;
  message: string;
  output: number | null;
  stage: Stage;
  state: StageState;
  windowMs: number;
};
export type PipelineSnapshot = {
  anchorQueue: number | null;
  budget: {
    closedReason: string | null;
    open: boolean;
    remainingBytes: number;
    remainingTracks: number;
  } | null;
  crawl: { frontier: number; storable: number; unstorable: number } | null;
  crawlZeroChecks: number;
  embedOldCapture: boolean | null;
  embedTrend?: { since: number; startingQueue: number } | null;
  markers: Record<Stage, Marker[] | null>;
  queues: { analyze: number | null; capture: number | null; embed: number | null };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MARKER_RUN_GRACE_MS = 5 * MINUTE;

export const PIPELINE_SLOS = {
  analyze: { windowMs: 45 * MINUTE },
  anchor: { minOutput: 20, ticks: 2, windowMs: 2 * HOUR },
  capture: { windowMs: HOUR },
  crawl: { frontierFloor: 1000, windowMs: 2 * HOUR },
  embed: { capacityWindowMs: 24 * HOUR, windowMs: 30 * MINUTE },
} as const;

export const CRAWL_SUPPLY_MIN_WRITES = 20;

export const BUDGET_EXHAUSTED_BYTES = 16 * 1024 * 1024;

const CADENCE: Record<Stage, number> = {
  analyze: 5 * MINUTE,
  anchor: HOUR,
  capture: 5 * MINUTE,
  crawl: 10 * MINUTE,
  embed: 5 * MINUTE,
  "funnel-snapshot": 24 * HOUR,
  "isrc-recovery": 10 * MINUTE,
};

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function withinFrontierRefreshWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Amsterdam",
    weekday: "short",
  }).formatToParts(now);
  const day = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return day === "Fri" && hour >= 6 && hour < 9;
}

function result(
  stage: Stage,
  state: StageState,
  cause: string,
  output: number | null,
  backlog: number | null,
  windowMs: number,
  action: string,
): StageVerdict {
  const duration =
    windowMs === 0
      ? "this check"
      : windowMs >= HOUR
        ? `${windowMs / HOUR}h`
        : `${windowMs / MINUTE}m`;
  return {
    backlog,
    cause,
    message: `${stage}: ${state.replaceAll("_", " ")} over ${duration}; ${output ?? "unknown"} produced / ${backlog ?? "unknown"} queued; ${cause.replaceAll("_", " ")}. ${action}`,
    output,
    stage,
    state,
    windowMs,
  };
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [value, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = value;
    }
  }
  return best;
}

const NAMED_CAUSE: Record<string, string> = {
  apify_budget_spent: "apify_budget_spent",
  breaker_quota: "breaker_quota",
  breaker_throttle: "breaker_throttle",
  database_admission: "admission_lane_closed",
  due_work_repair_pending: "due_work_repair_pending",
  friday_window: "friday_window",
  label_gate: "label_gate",
  mb_throttled: "vendor_gate",
  no_storable_work: "no_storable_work",
  quota_hold: "quota_hold",
  shared_meter: "shared_meter",
};

const isRepairPending = (summary: Record<string, unknown>): boolean =>
  summary.reason === "due_work_repair_pending";

const isLaneClosed = (summary: Record<string, unknown>): boolean =>
  summary.reason === "database_admission" ||
  (typeof summary.reason === "string" && summary.reason.includes("admission")) ||
  summary.gateState === "paused" ||
  summary.gateState === "admission-skipped";

function attributedCause(markers: Marker[]): string {
  const summaries = markers.map((marker) => marker.summary);
  const found = summaries.reduce((sum, summary) => sum + Number(summary.tracksFound ?? 0), 0);
  const gated = summaries.reduce(
    (sum, summary) => sum + Number(summary.tracksSkippedLabelGate ?? 0),
    0,
  );
  if (
    (found > 0 && gated >= found) ||
    summaries.some((summary) => summary.blockedReason === "label_gate")
  ) {
    return "label_gate";
  }
  const named = mostCommon(
    summaries.flatMap((summary) =>
      typeof summary.blockedReason === "string" && summary.blockedReason in NAMED_CAUSE
        ? [NAMED_CAUSE[summary.blockedReason] ?? summary.blockedReason]
        : [],
    ),
  );
  if (named) {
    return named;
  }
  if (summaries.some(isRepairPending)) {
    return "due_work_repair_pending";
  }
  if (summaries.some(isLaneClosed)) {
    return "admission_lane_closed";
  }
  if (
    summaries.some(
      (summary) =>
        !isRepairPending(summary) &&
        !isLaneClosed(summary) &&
        ((number(summary.apifySkippedAwaitingSpotify) !== null &&
          Number(summary.apifySkippedAwaitingSpotify) > 0 &&
          summary.spotifyIsrcAsks === 0) ||
          summary.throttled === true ||
          Number(summary.throttles ?? 0) > 0),
    )
  ) {
    return "vendor_gate";
  }
  if (
    summaries.some(
      (summary) =>
        Number(summary.tracksSkippedLabelGate ?? 0) > 0 ||
        Number(summary.failed ?? 0) > 0 ||
        Number(summary.embedFailed ?? 0) > 0,
    )
  ) {
    return "conversion_fault";
  }
  return "unexplained";
}

function stageMarkers(snapshot: PipelineSnapshot, stage: Stage, nowMs: number): Marker[] | null {
  const markers = snapshot.markers[stage];
  if (!markers?.length) {
    return null;
  }
  const sorted = [...markers].sort((a, b) => b.at - a.at);
  if (
    stage !== "funnel-snapshot" &&
    nowMs - (sorted[0]?.at ?? 0) >
      cronStaleBudgetMs({ cadenceMs: CADENCE[stage] }) + MARKER_RUN_GRACE_MS
  ) {
    return null;
  }
  return sorted;
}

function total(markers: Marker[], field: string): number | null {
  const values = markers.map((marker) =>
    marker.summary.gateState === "admission-skipped" && marker.summary.payloadStarted === false
      ? 0
      : number(marker.summary[field]),
  );
  return values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

function evaluateFunnel(markers: Marker[] | null, now: Date): StageVerdict {
  if (markers === null) {
    return result(
      "funnel-snapshot",
      "measurement_unavailable",
      "measurement_unavailable",
      null,
      null,
      0,
      "Check the funnel snapshot marker directory.",
    );
  }
  const beforeDeadline = now.getUTCHours() === 0 && now.getUTCMinutes() < 30;
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (beforeDeadline ? 2 : 1)),
  )
    .toISOString()
    .slice(0, 10);
  const present = markers?.some(
    ({ summary }) =>
      summary.ok === true &&
      (summary.day === day ||
        (Array.isArray(summary.backfilledDays) && summary.backfilledDays.includes(day))),
  );
  return present
    ? result("funnel-snapshot", "healthy", "none", 1, 1, 0, `The ${day} UTC snapshot is recorded.`)
    : result(
        "funnel-snapshot",
        "stalled",
        "snapshot_missing",
        0,
        1,
        0,
        `Record or repair the ${day} UTC snapshot.`,
      );
}

function inWindow(markers: Marker[], nowMs: number, windowMs: number): Marker[] {
  return markers.filter((marker) => marker.at >= nowMs - windowMs && marker.at <= nowMs);
}

function fullWindow(
  markers: Marker[],
  nowMs: number,
  windowMs: number,
  cadenceMs: number,
): boolean {
  return (
    markers.some((marker) => marker.at <= nowMs - windowMs + cadenceMs) &&
    markers.some(
      (marker) => marker.at >= nowMs - cronStaleBudgetMs({ cadenceMs }) - MARKER_RUN_GRACE_MS,
    )
  );
}

// oxlint-disable-next-line eslint/complexity
function evaluateStage(snapshot: PipelineSnapshot, stage: Stage, now: Date): StageVerdict {
  const nowMs = now.getTime();
  if (stage === "funnel-snapshot") {
    return evaluateFunnel(snapshot.markers[stage], now);
  }
  const backlog =
    stage === "crawl"
      ? (snapshot.crawl?.frontier ?? null)
      : stage === "anchor"
        ? snapshot.anchorQueue
        : stage === "capture" || stage === "analyze" || stage === "embed"
          ? snapshot.queues[stage]
          : stage === "isrc-recovery"
            ? ([...(snapshot.markers[stage] ?? [])]
                .sort((a, b) => b.at - a.at)
                .map((marker) => number(marker.summary.queueDepth))
                .find((depth) => depth !== null) ?? null)
            : null;
  const windowMs =
    stage === "crawl"
      ? PIPELINE_SLOS.crawl.windowMs
      : stage === "anchor"
        ? PIPELINE_SLOS.anchor.windowMs
        : stage === "capture"
          ? PIPELINE_SLOS.capture.windowMs
          : stage === "analyze"
            ? PIPELINE_SLOS.analyze.windowMs
            : stage === "embed"
              ? PIPELINE_SLOS.embed.windowMs
              : 0;
  const markers = stageMarkers(snapshot, stage, nowMs);
  if (
    !markers ||
    (stage === "crawl" && !snapshot.crawl) ||
    (stage === "capture" && !snapshot.budget) ||
    backlog === null ||
    (stage === "embed" && snapshot.embedOldCapture === null)
  ) {
    return result(
      stage,
      "measurement_unavailable",
      "measurement_unavailable",
      null,
      backlog,
      windowMs,
      "Check marker and agent read access.",
    );
  }
  if (stage === "anchor" && withinFrontierRefreshWindow(now)) {
    return result(
      stage,
      "scheduled_pause",
      "spotify_window",
      null,
      backlog,
      windowMs,
      "Resume after the Friday refresh window.",
    );
  }
  const latest = markers[0];
  if (!latest) {
    return result(
      stage,
      "measurement_unavailable",
      "measurement_unavailable",
      null,
      backlog,
      windowMs,
      "Check marker history.",
    );
  }
  const crawlRecentWrites =
    stage === "crawl"
      ? total(inWindow(markers, nowMs, PIPELINE_SLOS.crawl.windowMs), "tracksWritten")
      : null;
  if (
    stage === "crawl" &&
    (snapshot.crawl?.frontier ?? 0) >= PIPELINE_SLOS.crawl.frontierFloor &&
    snapshot.crawl?.storable === 0 &&
    (crawlRecentWrites ?? 0) < CRAWL_SUPPLY_MIN_WRITES
  ) {
    if (snapshot.crawlZeroChecks < 2) {
      return result(
        stage,
        "healthy",
        "supply_empty_pending",
        0,
        snapshot.crawl.unstorable,
        0,
        "Recheck the storable release count next tick.",
      );
    }
    return result(
      stage,
      "stalled",
      "supply_empty",
      0,
      snapshot.crawl.unstorable,
      0,
      "No storable releases queued; review label decisions.",
    );
  }
  if (
    stage === "capture" &&
    (snapshot.budget?.open === false ||
      (snapshot.budget?.remainingBytes ?? Infinity) < BUDGET_EXHAUSTED_BYTES)
  ) {
    return result(
      stage,
      "budget_closed",
      snapshot.budget.closedReason ?? "budget_exhausted",
      0,
      backlog,
      windowMs,
      "Capture resumes when the rolling budget reopens.",
    );
  }
  if (stage === "isrc-recovery") {
    return result(
      stage,
      "healthy",
      "none",
      number(latest.summary.produced),
      backlog,
      0,
      "No yield SLO for this supporting lane.",
    );
  }
  const recent = inWindow(markers, nowMs, windowMs);
  const outputField = stage === "crawl" ? "tracksWritten" : "produced";
  const output = total(recent, outputField);
  if (output === null) {
    return result(
      stage,
      "measurement_unavailable",
      "measurement_unavailable",
      null,
      backlog,
      windowMs,
      "Check marker summary counters.",
    );
  }
  if (backlog === 0) {
    return result(stage, "healthy", "supply_empty", output, backlog, windowMs, "No ready work.");
  }
  if (stage === "anchor") {
    const expected = markers
      .filter((marker) => !withinFrontierRefreshWindow(new Date(marker.at)))
      .slice(0, PIPELINE_SLOS.anchor.ticks);
    const anchorOutput = total(expected, "produced");

    if (
      expected.length > 0 &&
      expected.every((marker) => marker.summary.blockedReason === "apify_budget_spent") &&
      (anchorOutput ?? 0) < PIPELINE_SLOS.anchor.minOutput
    ) {
      return result(
        stage,
        "budget_closed",
        "apify_budget_spent",
        anchorOutput,
        backlog,
        windowMs,
        "Anchoring resumes when free lookups reopen or the paid budget resets at 00:00 UTC.",
      );
    }
    if (
      expected.some(
        (marker) =>
          marker.summary.gateReason === "quota_hold" ||
          marker.summary.blockedReason === "quota_hold",
      ) &&
      (anchorOutput ?? 0) < PIPELINE_SLOS.anchor.minOutput
    ) {
      return result(
        stage,
        "scheduled_pause",
        "quota_hold",
        anchorOutput,
        backlog,
        windowMs,
        "Resume when the quota hold lifts.",
      );
    }
    if (
      backlog !== null &&
      backlog >= 1000 &&
      expected.length === 2 &&
      anchorOutput !== null &&
      anchorOutput < PIPELINE_SLOS.anchor.minOutput
    ) {
      return result(
        stage,
        "stalled",
        attributedCause(expected),
        anchorOutput,
        backlog,
        windowMs,
        "Check the free Spotify gate and deferred rows.",
      );
    }
    return result(
      stage,
      "healthy",
      "none",
      anchorOutput,
      backlog,
      windowMs,
      "Watch the next open tick.",
    );
  }
  if (!fullWindow(markers, nowMs, windowMs, CADENCE[stage])) {
    return result(
      stage,
      "measurement_unavailable",
      "measurement_unavailable",
      output,
      backlog,
      windowMs,
      "Wait for a complete observation window.",
    );
  }
  if (output === 0) {
    return result(
      stage,
      "stalled",
      attributedCause(recent),
      output,
      backlog,
      windowMs,
      stage === "crawl"
        ? "Inspect the label gate and admission lane."
        : "Inspect the worklist and failed items.",
    );
  }
  if (stage === "embed") {
    const trend = snapshot.embedTrend;
    if (
      snapshot.embedOldCapture === true ||
      (trend !== null &&
        trend !== undefined &&
        nowMs - trend.since >= PIPELINE_SLOS.embed.capacityWindowMs &&
        backlog !== null &&
        backlog > trend.startingQueue)
    ) {
      return result(
        stage,
        "degraded",
        "capacity_below_intake",
        output,
        backlog,
        PIPELINE_SLOS.embed.capacityWindowMs,
        "Embedding is behind capture; run an off-box embed batch (M5 or RunPod) to drain it.",
      );
    }
  }
  return result(stage, "healthy", "none", output, backlog, windowMs, "Yield is moving.");
}

export function evaluatePipeline(snapshot: PipelineSnapshot, now: Date): StageVerdict[] {
  return (
    [
      "crawl",
      "anchor",
      "capture",
      "analyze",
      "embed",
      "isrc-recovery",
      "funnel-snapshot",
    ] as Stage[]
  ).map((stage) => evaluateStage(snapshot, stage, now));
}
