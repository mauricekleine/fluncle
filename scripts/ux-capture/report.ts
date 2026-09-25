export type RawPageMetrics = {
  playHookCount: number;
  playHeuristicCount: number;
  audioCount: number;
  interactiveTargets: Array<{ width: number; height: number }>;
  headings: Array<{ level: number; text: string }>;
  images: Array<{
    src: string;
    renderedWidth: number;
    renderedHeight: number;
    naturalWidth: number;
    naturalHeight: number;
    transferBytes: number | null;
  }>;
};

export type PageMetrics = {
  playHookCount: number;
  playHeuristicCount: number;
  audioCount: number;
  interactiveCount: number;
  undersizedInteractiveCount: number;
  headings: Array<{ level: number; text: string }>;
  firstHeading: { level: number; text: string } | null;
  h1PrecedesOtherHeadings: boolean;
  images: Array<{
    src: string;
    renderedWidth: number;
    renderedHeight: number;
    naturalWidth: number;
    naturalHeight: number;
    transferBytes: number | null;
  }>;
  knownImageBytes: number;
  oversizedImageCount: number;
};

export type TapToSoundProbe = {
  control: "hook" | "heuristic" | "none";
  audioPlayingWithin5s: boolean;
  stayedOnPage: boolean | null;
  scrollDeltaPx: number | null;
  error?: string;
};

export type PageCapture =
  | {
      path: string;
      viewport: "desktop" | "mobile";
      status: "ok";
      httpStatus: number;
      metrics: PageMetrics;
      tapToSound: TapToSoundProbe;
    }
  | {
      path: string;
      viewport: "desktop" | "mobile";
      status: "failed";
      httpStatus: number | null;
      error: string;
      metrics: null;
      tapToSound: null;
    };

export type OrphanAudioProbe = {
  trackPath: string | null;
  started: boolean;
  clientSideNavigation: boolean | null;
  stillPlayingAfterNavigation: boolean | null;
  visiblePauseControl: boolean | null;
  error?: string;
};

export type LighthouseSummary = {
  path: string;
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  fcpMs: number | null;
  targetSizeScore: number | null;
  error?: string;
};

export type CaptureReport = {
  baseUrl: string;
  capturedAt: string;
  pages: PageCapture[];
  lighthouse: LighthouseSummary[];
  orphanAudio: OrphanAudioProbe | null;
};

export function normalizePageMetrics(raw: RawPageMetrics): PageMetrics {
  const headings = raw.headings.map(({ level, text }) => ({ level, text: text.trim() }));
  const firstHeading = headings[0] ?? null;
  const firstH1Index = headings.findIndex(({ level }) => level === 1);
  const h1PrecedesOtherHeadings =
    firstH1Index === 0 || (firstH1Index === -1 && headings.length === 0);
  const images = raw.images.map((entry) => ({ ...entry }));

  return {
    audioCount: raw.audioCount,
    firstHeading,
    h1PrecedesOtherHeadings,
    headings,
    images,
    interactiveCount: raw.interactiveTargets.length,
    knownImageBytes: images.reduce(
      (sum, image) =>
        sum + (image.transferBytes !== null && image.transferBytes > 0 ? image.transferBytes : 0),
      0,
    ),
    oversizedImageCount: images.filter(
      (image) =>
        image.renderedWidth > 0 &&
        image.renderedHeight > 0 &&
        (image.naturalWidth > image.renderedWidth * 2 ||
          image.naturalHeight > image.renderedHeight * 2),
    ).length,
    playHeuristicCount: raw.playHeuristicCount,
    playHookCount: raw.playHookCount,
    undersizedInteractiveCount: raw.interactiveTargets.filter(
      ({ width, height }) => width < 44 || height < 44,
    ).length,
  };
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function milliseconds(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(1)} s`;
}

function score(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

function tapResult(probe: TapToSoundProbe): string {
  if (probe.error) {
    return "probe failed";
  }
  if (probe.control === "none") {
    return "none";
  }
  return probe.audioPlayingWithin5s ? "1" : "no sound in 5 s";
}

function stayedInPlace(probe: TapToSoundProbe): string {
  if (probe.error || probe.control === "none" || probe.stayedOnPage === null) {
    return "—";
  }
  if (!probe.stayedOnPage) {
    return "No";
  }
  return probe.scrollDeltaPx === null || Math.abs(probe.scrollDeltaPx) <= 2 ? "Yes" : "No";
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

export function renderSummary(report: CaptureReport): string {
  const mobilePages = report.pages.filter(({ viewport }) => viewport === "mobile");
  const scoreboard = mobilePages.map((page) => {
    const { path } = page;
    if (page.status === "failed") {
      const status = page.httpStatus === null ? "request failed" : `HTTP ${page.httpStatus}`;
      return [`\`${path}\``, "—", "—", `Capture failed (${status}); see metrics JSON`];
    }
    const { metrics } = page;
    const lighthouse = report.lighthouse.find((entry) => entry.path === path);
    const verdict = `${metrics.playHookCount} hooked / ${metrics.playHeuristicCount} named play controls; ${metrics.audioCount} audio; ${metrics.undersizedInteractiveCount}/${metrics.interactiveCount} small targets`;
    return [
      `\`${path}\``,
      "—",
      lighthouse?.error ? "probe failed" : milliseconds(lighthouse?.lcpMs ?? null),
      verdict,
    ];
  });
  const taps = report.pages.map((page) => {
    const label = `\`${page.path}\` (${page.viewport})`;
    if (page.status === "failed") {
      return [label, "Page failed", "probe failed", "—"];
    }
    const { tapToSound } = page;
    return [
      label,
      tapToSound.control === "none"
        ? "No inline control"
        : `First ${tapToSound.control} play control`,
      tapResult(tapToSound),
      stayedInPlace(tapToSound),
    ];
  });
  const targets = report.pages.map((page) => {
    const label = `\`${page.path}\``;
    if (page.status === "failed") {
      return [label, page.viewport, "probe failed", "—", "—", "—", "—", "—"];
    }
    const { metrics } = page;
    return [
      label,
      page.viewport,
      String(metrics.interactiveCount),
      String(metrics.undersizedInteractiveCount),
      metrics.interactiveCount === 0
        ? "—"
        : `${Math.round((metrics.undersizedInteractiveCount / metrics.interactiveCount) * 100)}%`,
      metrics.h1PrecedesOtherHeadings ? "Yes" : "No",
      String(metrics.oversizedImageCount),
      metrics.knownImageBytes === 0 ? "—" : `${Math.round(metrics.knownImageBytes / 1024)} KB`,
    ];
  });
  const lighthouse = report.lighthouse.map((entry) =>
    entry.error
      ? [`\`${entry.path}\``, "probe failed", "—", "—", "—", "—", "—", "—"]
      : [
          `\`${entry.path}\``,
          score(entry.performance),
          score(entry.accessibility),
          score(entry.bestPractices),
          score(entry.seo),
          milliseconds(entry.lcpMs),
          milliseconds(entry.fcpMs),
          entry.targetSizeScore === null ? "—" : entry.targetSizeScore.toFixed(2),
        ],
  );
  const orphan = report.orphanAudio;
  const orphanResult =
    orphan === null
      ? "Not run."
      : orphan.error
        ? `Probe failed: ${orphan.error}`
        : orphan.started
          ? `Started on ${orphan.trackPath ?? "a track page"}; client-side navigation: ${orphan.clientSideNavigation ? "yes" : "no"}; playing after navigation: ${orphan.stillPlayingAfterNavigation ? "yes" : "no"}; visible pause control: ${orphan.visiblePauseControl ? "yes" : "no"}.`
          : `No preview started on ${orphan.trackPath ?? "a track page"}.`;

  return [
    "# Discovery UX capture",
    "",
    `Base: ${report.baseUrl}`,
    `Captured: ${report.capturedAt}`,
    "",
    "## Scoreboard",
    "",
    "Nielsen scores require a manual critique; this capture records the other columns.",
    "",
    table(["Page", "Nielsen /40", "Mobile LCP", "One-line verdict"], scoreboard),
    "",
    "## The headline measurement: taps to hear a track",
    "",
    table(["From", "Path to sound", "Taps", "Keeps your place?"], taps),
    "",
    `**Orphaned audio:** ${orphanResult}`,
    "",
    "## Target sizes and page structure",
    "",
    table(
      [
        "Page",
        "Viewport",
        "Interactive",
        "Under 44 px",
        "Share",
        "H1 first?",
        "Oversized images",
        "Known image bytes",
      ],
      targets,
    ),
    "",
    "Known image bytes sum only resource entries that expose transfer size; cross-origin and cached images may be missing.",
    "",
    "## Lighthouse mobile",
    "",
    table(
      [
        "Page",
        "Performance",
        "Accessibility",
        "Best practices",
        "SEO",
        "LCP",
        "FCP",
        "Target size",
      ],
      lighthouse,
    ),
    "",
  ].join("\n");
}
