import { describe, expect, test } from "bun:test";

import {
  normalizePageMetrics,
  renderSummary,
  type CaptureReport,
  type RawPageMetrics,
} from "./report";

const raw: RawPageMetrics = {
  audioCount: 1,
  headings: [
    { level: 2, text: " Palette " },
    { level: 1, text: "Tracks" },
  ],
  images: [
    {
      naturalHeight: 640,
      naturalWidth: 640,
      renderedHeight: 40,
      renderedWidth: 40,
      src: "cover-a",
      transferBytes: 32_768,
    },
    {
      naturalHeight: 80,
      naturalWidth: 80,
      renderedHeight: 40,
      renderedWidth: 40,
      src: "cover-b",
      transferBytes: null,
    },
  ],
  interactiveTargets: [
    { height: 44, width: 44 },
    { height: 43.99, width: 70 },
    { height: 70, width: 30 },
  ],
  playHeuristicCount: 2,
  playHookCount: 1,
};

describe("normalizePageMetrics", () => {
  test("counts small targets by either dimension and excludes exactly 44 px", () => {
    const metrics = normalizePageMetrics(raw);

    expect(metrics.interactiveCount).toBe(3);
    expect(metrics.undersizedInteractiveCount).toBe(2);
    expect(metrics.playHookCount).toBe(1);
    expect(metrics.playHeuristicCount).toBe(2);
    expect(metrics.audioCount).toBe(1);
  });

  test("preserves heading order and counts only known oversized image transfers", () => {
    const metrics = normalizePageMetrics(raw);

    expect(metrics.firstHeading).toEqual({ level: 2, text: "Palette" });
    expect(metrics.h1PrecedesOtherHeadings).toBe(false);
    expect(metrics.headings).toEqual([
      { level: 2, text: "Palette" },
      { level: 1, text: "Tracks" },
    ]);
    expect(metrics.oversizedImageCount).toBe(1);
    expect(metrics.knownImageBytes).toBe(32_768);
  });
});

describe("renderSummary", () => {
  test("renders the baseline table shapes with measured Lighthouse and tap results", () => {
    const metrics = normalizePageMetrics(raw);
    const report: CaptureReport = {
      baseUrl: "https://example.test",
      capturedAt: "2026-09-24T12:00:00.000Z",
      lighthouse: [
        {
          accessibility: 98,
          bestPractices: 100,
          fcpMs: 2100,
          lcpMs: 7800,
          path: "/tracks",
          performance: 67,
          seo: 92,
          targetSizeScore: 0,
        },
      ],
      orphanAudio: {
        clientSideNavigation: true,
        started: true,
        stillPlayingAfterNavigation: true,
        trackPath: "/track/abc",
        visiblePauseControl: false,
      },
      pages: [
        {
          httpStatus: 200,
          metrics,
          path: "/tracks",
          status: "ok",
          tapToSound: {
            audioPlayingWithin5s: true,
            control: "hook",
            scrollDeltaPx: 1,
            stayedOnPage: true,
          },
          viewport: "mobile",
        },
        {
          httpStatus: 200,
          metrics,
          path: "/search?q=liquid|rollers",
          status: "ok",
          tapToSound: {
            audioPlayingWithin5s: false,
            control: "none",
            scrollDeltaPx: null,
            stayedOnPage: null,
          },
          viewport: "desktop",
        },
      ],
    };

    const summary = renderSummary(report);

    expect(summary).toContain("| Page | Nielsen /40 | Mobile LCP | One-line verdict |");
    expect(summary).toContain(
      "| `/tracks` | — | 7.8 s | 1 hooked / 2 named play controls; 1 audio; 2/3 small targets |",
    );
    expect(summary).toContain("| From | Path to sound | Taps | Keeps your place? |");
    expect(summary).toContain("| `/tracks` (mobile) | First hook play control | 1 | Yes |");
    expect(summary).toContain(
      "| `/search?q=liquid\\|rollers` (desktop) | No inline control | none | — |",
    );
    expect(summary).toContain("| `/tracks` | mobile | 3 | 2 | 67% | No | 1 | 32 KB |");
    expect(summary).toContain("| `/tracks` | 67 | 98 | 100 | 92 | 7.8 s | 2.1 s | 0.00 |");
    expect(summary).toContain("playing after navigation: yes; visible pause control: no");
  });

  test("marks failed pages without inventing control or target measurements", () => {
    const report: CaptureReport = {
      baseUrl: "https://example.test",
      capturedAt: "2026-09-24T12:00:00.000Z",
      lighthouse: [],
      orphanAudio: null,
      pages: [
        {
          error: "HTTP 404",
          httpStatus: 404,
          metrics: null,
          path: "/missing",
          status: "failed",
          tapToSound: null,
          viewport: "mobile",
        },
      ],
    };
    const summary = renderSummary(report);
    expect(summary).toContain("Capture failed (HTTP 404); see metrics JSON");
    expect(summary).toContain("| `/missing` (mobile) | Page failed | probe failed | — |");
    expect(summary).not.toContain("No inline control");
    expect(summary).not.toContain("0/0 small targets");
  });

  test("shows tap and Lighthouse probe failures as failures", () => {
    const report: CaptureReport = {
      baseUrl: "https://example.test",
      capturedAt: "2026-09-24T12:00:00.000Z",
      lighthouse: [
        {
          accessibility: null,
          bestPractices: null,
          error: "Chrome unavailable",
          fcpMs: null,
          lcpMs: null,
          path: "/tracks",
          performance: null,
          seo: null,
          targetSizeScore: null,
        },
      ],
      orphanAudio: null,
      pages: [
        {
          httpStatus: 200,
          metrics: normalizePageMetrics(raw),
          path: "/tracks",
          status: "ok",
          tapToSound: {
            audioPlayingWithin5s: false,
            control: "hook",
            error: "click timed out",
            scrollDeltaPx: null,
            stayedOnPage: true,
          },
          viewport: "mobile",
        },
      ],
    };
    const summary = renderSummary(report);
    expect(summary).toContain(
      "| `/tracks` (mobile) | First hook play control | probe failed | — |",
    );
    expect(summary).toContain("| `/tracks` | probe failed | — | — | — | — | — | — |");
    expect(summary).toContain("| `/tracks` | — | probe failed |");
  });
});
