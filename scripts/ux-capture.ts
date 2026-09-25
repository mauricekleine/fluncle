#!/usr/bin/env bun

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePageMetrics,
  renderSummary,
  type CaptureReport,
  type LighthouseSummary,
  type OrphanAudioProbe,
  type PageCapture,
  type RawPageMetrics,
  type TapToSoundProbe,
} from "./ux-capture/report";

const DEFAULT_PAGES = [
  "/",
  "/search",
  "/search?q=liquid",
  "/search?q=noisia",
  "/search?q=zzqxvbnm",
  "/tracks",
  "/artists",
  "/albums",
  "/labels",
  "/fresh",
];
const LIGHTHOUSE_PAGES = new Set(["/", "/search?q=liquid", "/tracks", "/artists", "/fresh"]);
const PLAY_NAME = /\b(play|preview)\b/i;
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

type Options = { baseUrl: string; out: string; lighthouse: boolean; pages: string[] };

function usage(): never {
  throw new Error(
    "Usage: bun run ux:capture -- --base <url> [--out <dir>] [--no-lighthouse] [--pages /,/tracks,...]",
  );
}

function parseArgs(args: string[]): Options {
  let base: string | undefined;
  let out: string | undefined;
  let lighthouse = true;
  let pages = DEFAULT_PAGES;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") {
      base = args[++index];
    } else if (arg === "--out") {
      out = args[++index];
    } else if (arg === "--pages") {
      pages = (args[++index] ?? "").split(",").filter(Boolean);
    } else if (arg === "--no-lighthouse") {
      lighthouse = false;
    } else {
      usage();
    }
  }
  if (!base || pages.length === 0 || pages.some((path) => !path.startsWith("/"))) {
    usage();
  }
  const baseUrl = new URL(base);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    usage();
  }
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    lighthouse,
    out: out ?? join(tmpdir(), `fluncle-ux-capture-${Date.now()}`),
    pages: [...new Set(pages)],
  };
}

function pageUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).href;
}

function fileStem(path: string): string {
  const url = new URL(path, "https://capture.invalid");
  const slug = [
    url.pathname === "/" ? "home" : url.pathname.slice(1),
    ...Array.from(url.searchParams.entries(), ([key, value]) => `${key}-${value}`),
  ].join("-");
  return slug.replace(/[^a-zA-Z0-9-]/g, "-");
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
}

async function revealLazyImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(500, window.innerHeight - 100);
    const maxScroll = Math.min(document.documentElement.scrollHeight, 30 * step);
    for (let y = 0; y < maxScroll; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => window.setTimeout(resolve, 110));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

async function rawMetrics(page: Page): Promise<RawPageMetrics> {
  const dom = await page.evaluate(() => {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])',
      ),
    ).flatMap((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (
        style.visibility !== "visible" ||
        style.display === "none" ||
        style.clipPath !== "none" ||
        style.clip !== "auto" ||
        element.getClientRects().length === 0 ||
        box.width <= 1 ||
        box.height <= 1
      ) {
        return [];
      }
      let visible = box;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (
          /^(hidden|clip|scroll|auto)$/.test(ancestorStyle.overflowX) ||
          /^(hidden|clip|scroll|auto)$/.test(ancestorStyle.overflowY)
        ) {
          const clip = ancestor.getBoundingClientRect();
          visible = new DOMRect(
            Math.max(visible.left, clip.left),
            Math.max(visible.top, clip.top),
            Math.max(0, Math.min(visible.right, clip.right) - Math.max(visible.left, clip.left)),
            Math.max(0, Math.min(visible.bottom, clip.bottom) - Math.max(visible.top, clip.top)),
          );
          if (visible.width <= 1 || visible.height <= 1) {
            return [];
          }
        }
      }
      return [{ height: visible.height, width: visible.width }];
    });
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const bytesByUrl = new Map(
      resources.map((resource) => [
        resource.name,
        resource.transferSize || resource.decodedBodySize || null,
      ]),
    );
    return {
      audioCount: document.querySelectorAll("audio").length,
      headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: (heading.textContent ?? "").trim().replace(/\s+/g, " "),
      })),
      images: Array.from(document.images).map((image) => {
        const box = image.getBoundingClientRect();
        return {
          naturalHeight: image.naturalHeight,
          naturalWidth: image.naturalWidth,
          renderedHeight: Math.round(box.height),
          renderedWidth: Math.round(box.width),
          src: image.currentSrc || image.src,
          transferBytes: bytesByUrl.get(image.currentSrc || image.src) ?? null,
        };
      }),
      interactiveTargets: targets,
      playHookCount: document.querySelectorAll("[data-discovery-play]").length,
    };
  });
  const playHeuristicCount = await page.getByRole("button", { name: PLAY_NAME }).count();
  return { ...dom, playHeuristicCount };
}

async function firstPlayControl(
  page: Page,
): Promise<{ control: "hook" | "heuristic" | "none"; locator: Locator | null }> {
  const hooked = page.locator("[data-discovery-play]:visible");
  if ((await hooked.count()) > 0) {
    return { control: "hook", locator: hooked.first() };
  }
  const heuristic = page.getByRole("button", { name: PLAY_NAME });
  if ((await heuristic.count()) > 0) {
    return { control: "heuristic", locator: heuristic.first() };
  }
  return { control: "none", locator: null };
}

async function installAudioProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const tracked: HTMLAudioElement[] = [];
    (window as Window & { __uxCaptureAudio?: HTMLAudioElement[] }).__uxCaptureAudio = tracked;
    window.Audio = new Proxy(window.Audio, {
      construct(target, args, newTarget) {
        const element = Reflect.construct(target, args, newTarget) as HTMLAudioElement;
        tracked.push(element);
        return element;
      },
    });
  });
}

async function audioHasSound(): Promise<boolean> {
  const detached =
    (window as Window & { __uxCaptureAudio?: HTMLAudioElement[] }).__uxCaptureAudio ?? [];
  const candidates = [...document.querySelectorAll("audio"), ...detached].filter(
    (audio) =>
      audio.readyState >= 3 && !audio.paused && !audio.ended && !audio.muted && audio.volume > 0,
  );
  if (candidates.length === 0) {
    return false;
  }
  const positions = candidates.map((audio) => audio.currentTime);
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  return candidates.some(
    (audio, index) =>
      audio.readyState >= 3 &&
      !audio.paused &&
      !audio.ended &&
      !audio.muted &&
      audio.volume > 0 &&
      audio.currentTime > (positions[index] ?? Infinity),
  );
}

async function tapToSound(page: Page): Promise<TapToSoundProbe> {
  const choice = await firstPlayControl(page);
  if (choice.locator === null) {
    return {
      audioPlayingWithin5s: false,
      control: "none",
      scrollDeltaPx: null,
      stayedOnPage: null,
    };
  }
  try {
    await choice.locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  } catch (error) {
    return {
      audioPlayingWithin5s: false,
      control: choice.control,
      error: String(error),
      scrollDeltaPx: null,
      stayedOnPage: null,
    };
  }
  const before = await page.evaluate(() => window.scrollY);
  const url = page.url();
  try {
    const startedAt = Date.now();
    await choice.locator.click({ timeout: 5_000 });
    let audible = false;
    try {
      await page.waitForFunction(audioHasSound, undefined, {
        timeout: Math.max(1, 5_000 - (Date.now() - startedAt)),
      });
      audible = true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") {
        throw error;
      }
    }
    const after = await page.evaluate(() => window.scrollY);
    return {
      audioPlayingWithin5s: audible,
      control: choice.control,
      scrollDeltaPx: Math.round(after - before),
      stayedOnPage: page.url() === url,
    };
  } catch (error) {
    const after = await page.evaluate(() => window.scrollY).catch(() => null);
    return {
      audioPlayingWithin5s: false,
      control: choice.control,
      error: String(error),
      scrollDeltaPx: after === null ? null : Math.round(after - before),
      stayedOnPage: page.url() === url,
    };
  }
}

async function capturePage(
  browser: Browser,
  options: Options,
  path: string,
  viewport: "desktop" | "mobile",
): Promise<PageCapture> {
  let httpStatus: number | null = null;
  const mobile = viewport === "mobile";
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({
      deviceScaleFactor: mobile ? 2 : 1,
      hasTouch: mobile,
      isMobile: mobile,
      viewport: mobile ? { height: 844, width: 390 } : { height: 900, width: 1440 },
      ...(mobile ? { userAgent: MOBILE_UA } : {}),
    });
    await installAudioProbe(context);
    const page = await context.newPage();
    const response = await page.goto(pageUrl(options.baseUrl, path), {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    httpStatus = response?.status() ?? null;
    if (httpStatus === null || !response?.ok()) {
      throw new Error(
        httpStatus === null ? "Navigation returned no HTTP response" : `HTTP ${httpStatus}`,
      );
    }
    await settle(page);
    const stem = `${fileStem(path)}-${viewport}`;
    await page.screenshot({ path: join(options.out, `${stem}-viewport.png`) });
    await revealLazyImages(page);
    await page.screenshot({ fullPage: true, path: join(options.out, `${stem}-full.png`) });
    const metrics = normalizePageMetrics(await rawMetrics(page));
    const tap = await tapToSound(page);
    return { httpStatus, metrics, path, status: "ok", tapToSound: tap, viewport };
  } catch (error) {
    return {
      error: String(error),
      httpStatus,
      metrics: null,
      path,
      status: "failed",
      tapToSound: null,
      viewport,
    };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function orphanAudio(browser: Browser, options: Options): Promise<OrphanAudioProbe> {
  const context = await browser.newContext({ viewport: { height: 900, width: 1440 } });
  try {
    await installAudioProbe(context);
    const page = await context.newPage();
    const tracksResponse = await page.goto(pageUrl(options.baseUrl, "/tracks"), {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    if (!tracksResponse?.ok()) {
      throw new Error(
        `Orphan probe /tracks returned HTTP ${tracksResponse?.status() ?? "no response"}`,
      );
    }
    await settle(page);
    const paths = await page
      .locator('a[href^="/track/"]')
      .evaluateAll((links) =>
        [
          ...new Set(
            links
              .map((link) => (link as HTMLAnchorElement).getAttribute("href"))
              .filter((href): href is string => Boolean(href)),
          ),
        ].slice(0, 50),
      );
    if (paths.length === 0) {
      return {
        clientSideNavigation: null,
        error: "No track link on /tracks",
        started: false,
        stillPlayingAfterNavigation: null,
        trackPath: null,
        visiblePauseControl: null,
      };
    }
    for (const trackPath of paths) {
      const response = await page.goto(pageUrl(options.baseUrl, trackPath), {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      if (!response?.ok()) {
        continue;
      }
      await settle(page);
      const choice = await firstPlayControl(page);
      if (choice.locator === null) {
        continue;
      }
      try {
        await choice.locator.click({ timeout: 5_000 });
        await page.waitForFunction(audioHasSound, undefined, { timeout: 5_000 });
      } catch {
        continue;
      }
      const tracksLink = page.locator('a[href="/tracks"]:visible').first();
      if ((await tracksLink.count()) === 0) {
        return {
          clientSideNavigation: null,
          error: "No visible /tracks link for client navigation",
          started: true,
          stillPlayingAfterNavigation: null,
          trackPath,
          visiblePauseControl: null,
        };
      }
      await page.evaluate(() => {
        (window as Window & { __uxCaptureNavMarker?: boolean }).__uxCaptureNavMarker = true;
      });
      await tracksLink.click({ timeout: 5_000 });
      await page.waitForURL((url) => url.pathname === "/tracks", { timeout: 10_000 });
      await settle(page);
      const clientSideNavigation = await page.evaluate(
        () => (window as Window & { __uxCaptureNavMarker?: boolean }).__uxCaptureNavMarker === true,
      );
      return {
        clientSideNavigation,
        ...(clientSideNavigation
          ? {}
          : {
              error:
                "Navigation replaced the document; orphan probe requires client-side navigation",
            }),
        started: true,
        stillPlayingAfterNavigation: clientSideNavigation
          ? await page.evaluate(audioHasSound)
          : null,
        trackPath,
        visiblePauseControl: await page
          .getByRole("button", { name: /pause/i })
          .first()
          .isVisible()
          .catch(() => false),
      };
    }
    return {
      clientSideNavigation: null,
      error: "No preview started on up to 50 track links",
      started: false,
      stillPlayingAfterNavigation: null,
      trackPath: paths[0] ?? null,
      visiblePauseControl: null,
    };
  } finally {
    await context.close();
  }
}

async function runLighthouse(options: Options, path: string): Promise<LighthouseSummary> {
  const outputPath = join(options.out, `lighthouse-${fileStem(path)}.json`);
  const args = [
    "lighthouse@13.5.0",
    pageUrl(options.baseUrl, path),
    "--output=json",
    `--output-path=${outputPath}`,
    "--only-categories=performance,accessibility,best-practices,seo",
    "--form-factor=mobile",
    "--chrome-flags=--headless=new",
    "--quiet",
  ];
  const child = Bun.spawn(["bunx", ...args], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) {
    return failedLighthouse(path, stderr.trim() || `Lighthouse exited ${exitCode}`);
  }
  const result = JSON.parse(await readFile(outputPath, "utf8")) as {
    categories?: Record<string, { score?: number }>;
    audits?: Record<string, { numericValue?: number; score?: number }>;
    runtimeError?: { message?: string };
  };
  if (result.runtimeError || result.categories?.performance?.score == null) {
    return failedLighthouse(
      path,
      result.runtimeError?.message ?? "Lighthouse returned no performance score",
    );
  }
  const score = (name: string): number | null =>
    result.categories?.[name]?.score == null
      ? null
      : Math.round((result.categories[name]?.score ?? 0) * 100);
  return {
    accessibility: score("accessibility"),
    bestPractices: score("best-practices"),
    fcpMs: result.audits?.["first-contentful-paint"]?.numericValue ?? null,
    lcpMs: result.audits?.["largest-contentful-paint"]?.numericValue ?? null,
    path,
    performance: score("performance"),
    seo: score("seo"),
    targetSizeScore: result.audits?.["target-size"]?.score ?? null,
  };
}

function failedLighthouse(path: string, error: string): LighthouseSummary {
  return {
    accessibility: null,
    bestPractices: null,
    error,
    fcpMs: null,
    lcpMs: null,
    path,
    performance: null,
    seo: null,
    targetSizeScore: null,
  };
}

function failedPage(path: string, viewport: "desktop" | "mobile", error: unknown): PageCapture {
  return {
    error: String(error),
    httpStatus: null,
    metrics: null,
    path,
    status: "failed",
    tapToSound: null,
    viewport,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  await mkdir(options.out, { recursive: true });
  const report: CaptureReport = {
    baseUrl: options.baseUrl,
    capturedAt: new Date().toISOString(),
    lighthouse: [],
    orphanAudio: null,
    pages: [],
  };
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const path of options.pages) {
      for (const viewport of ["desktop", "mobile"] as const) {
        console.log(`capture ${path} ${viewport}`);
        let capture: PageCapture;
        try {
          capture = await capturePage(browser, options, path, viewport);
        } catch (error) {
          capture = failedPage(path, viewport, error);
        }
        report.pages.push(capture);
        await writeFile(
          join(options.out, `${fileStem(path)}-${viewport}.json`),
          `${JSON.stringify(capture, null, 2)}\n`,
        );
      }
    }
    if (options.pages.includes("/tracks")) {
      console.log("capture orphan audio");
      try {
        report.orphanAudio = await orphanAudio(browser, options);
      } catch (error) {
        report.orphanAudio = {
          clientSideNavigation: null,
          error: String(error),
          started: false,
          stillPlayingAfterNavigation: null,
          trackPath: null,
          visiblePauseControl: null,
        };
      }
    }
  } catch (error) {
    for (const path of options.pages) {
      for (const viewport of ["desktop", "mobile"] as const) {
        if (report.pages.some((page) => page.path === path && page.viewport === viewport)) {
          continue;
        }
        const capture = failedPage(path, viewport, error);
        report.pages.push(capture);
        await writeFile(
          join(options.out, `${fileStem(path)}-${viewport}.json`),
          `${JSON.stringify(capture, null, 2)}\n`,
        );
      }
    }
    if (options.pages.includes("/tracks") && report.orphanAudio === null) {
      report.orphanAudio = {
        clientSideNavigation: null,
        error: String(error),
        started: false,
        stillPlayingAfterNavigation: null,
        trackPath: null,
        visiblePauseControl: null,
      };
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  if (options.lighthouse) {
    for (const path of options.pages.filter((page) => LIGHTHOUSE_PAGES.has(page))) {
      console.log(`lighthouse ${path}`);
      try {
        report.lighthouse.push(await runLighthouse(options, path));
      } catch (error) {
        report.lighthouse.push(failedLighthouse(path, String(error)));
      }
    }
  }
  await writeFile(join(options.out, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(options.out, "summary.md"), renderSummary(report));
  console.log(`Capture complete: ${join(options.out, "summary.md")}`);
}

await main();
