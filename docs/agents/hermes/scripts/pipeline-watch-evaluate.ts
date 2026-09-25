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
  budget: {
    closedReason: string | null;
    open: boolean;
    remainingBytes: number;
    remainingTracks: number;
  } | null;
  crawl: { frontier: number; storable: number; unstorable: number } | null;
  embedOldCapture: boolean | null;
  embedTrend?: { since: number; startingQueue: number } | null;
  markers: Record<Stage, Marker[] | null>;
  queues: { analyze: number | null; capture: number | null; embed: number | null };
  quiesced: boolean;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The audit measured 72 zero-write crawl ticks, 99/100 anchor deferrals, 39–42 captures/hour, and 18–25 embeds/hour; these shorter zero-yield windows are the initial tripwire.
export const PIPELINE_SLOS = {
  analyze: { windowMs: 45 * MINUTE },
  anchor: { minOutput: 20, ticks: 2, windowMs: 2 * HOUR },
  capture: { windowMs: HOUR },
  crawl: { frontierFloor: 1000, windowMs: 2 * HOUR },
  embed: { capacityWindowMs: 24 * HOUR, windowMs: 30 * MINUTE },
} as const;

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

function attributedCause(markers: Marker[]): string {
  const summaries = markers.map((marker) => marker.summary);
  if (
    summaries.some(
      (summary) =>
        summary.reason === "database_admission" ||
        (typeof summary.reason === "string" && summary.reason.includes("admission")),
    )
  ) {
    return "admission_lane_closed";
  }
  if (summaries.some((summary) => summary.reason === "due_work_repair_pending")) {
    return "due_work_repair_pending";
  }
  if (summaries.some((summary) => summary.gateState === "paused")) {
    return "admission_lane_closed";
  }
  if (
    summaries.some(
      (summary) =>
        (number(summary.apifySkippedAwaitingSpotify) !== null &&
          Number(summary.apifySkippedAwaitingSpotify) > 0 &&
          summary.spotifyIsrcAsks === 0) ||
        summary.throttled === true ||
        Number(summary.throttles ?? 0) > 0,
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
    nowMs - (sorted[0]?.at ?? 0) > CADENCE[stage] * 2 + 2 * MINUTE
  ) {
    return null;
  }
  return sorted;
}

function total(markers: Marker[], field: string): number | null {
  const values = markers.map((marker) => number(marker.summary[field]));
  return values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
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
    markers.some((marker) => marker.at >= nowMs - cadenceMs * 2)
  );
}

// oxlint-disable-next-line eslint/complexity
function evaluateStage(snapshot: PipelineSnapshot, stage: Stage, now: Date): StageVerdict {
  const nowMs = now.getTime();
  const backlog =
    stage === "crawl"
      ? (snapshot.crawl?.frontier ?? null)
      : stage === "anchor"
        ? number(snapshot.markers.anchor?.[0]?.summary.queueDepth)
        : stage === "capture" || stage === "analyze" || stage === "embed"
          ? snapshot.queues[stage]
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
  if (stage === "funnel-snapshot" && !markers) {
    return result(
      stage,
      now.toISOString().slice(11, 16) >= "00:30" ? "stalled" : "measurement_unavailable",
      "snapshot_missing",
      0,
      1,
      0,
      "Check the daily snapshot sweep.",
    );
  }
  if (
    !markers ||
    (stage === "crawl" && !snapshot.crawl) ||
    (stage === "capture" && !snapshot.budget) ||
    ((stage === "capture" || stage === "analyze" || stage === "embed") && backlog === null) ||
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
  if (snapshot.quiesced) {
    return result(
      stage,
      "scheduled_pause",
      "timer_quiesced",
      null,
      backlog,
      windowMs,
      "Wait for the image swap to finish.",
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
  if (
    stage === "crawl" &&
    (snapshot.crawl?.frontier ?? 0) >= PIPELINE_SLOS.crawl.frontierFloor &&
    snapshot.crawl?.storable === 0
  ) {
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
  if (stage === "capture" && snapshot.budget?.open === false) {
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
  if (stage === "funnel-snapshot") {
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    )
      .toISOString()
      .slice(0, 10);
    const due = now.toISOString().slice(11, 16) >= "00:30";
    const present = markers.some(
      ({ summary }) =>
        summary.ok === true &&
        (summary.day === yesterday ||
          (Array.isArray(summary.backfilledDays) && summary.backfilledDays.includes(yesterday))),
    );
    return due && !present
      ? result(
          stage,
          "stalled",
          "snapshot_missing",
          0,
          1,
          0,
          `Record or repair the ${yesterday} UTC snapshot.`,
        )
      : result(stage, "healthy", "none", present ? 1 : 0, 1, 0, `Next UTC day follows ${today}.`);
  }
  if (stage === "isrc-recovery") {
    return result(
      stage,
      "healthy",
      "none",
      number(latest.summary.produced),
      number(latest.summary.queueDepth),
      0,
      "No yield SLO for this supporting lane.",
    );
  }
  const recent = inWindow(markers, nowMs, windowMs);
  const outputField =
    stage === "crawl" ? "tracksWritten" : stage === "anchor" ? "produced" : "done";
  const output =
    total(recent, outputField) ?? (stage === "analyze" ? total(recent, "produced") : null);
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
  if ((backlog ?? 0) === 0) {
    return result(stage, "healthy", "supply_empty", output, backlog, windowMs, "No ready work.");
  }
  if (stage === "anchor") {
    const expected = markers
      .filter((marker) => !withinFrontierRefreshWindow(new Date(marker.at)))
      .slice(0, PIPELINE_SLOS.anchor.ticks);
    const anchorOutput = total(expected, "produced");
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
        "Increase embed capacity or reduce intake.",
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
