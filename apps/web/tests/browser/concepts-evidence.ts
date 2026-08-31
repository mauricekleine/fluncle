#!/usr/bin/env bun
/**
 * Captures the browser evidence for the three held discovery concepts.
 *
 * Deliberately a hand-rolled script under `tests/browser/` rather than a spec
 * under `tests/e2e/`: the e2e suite is assertion-based and screenshots only on
 * failure, while this run's whole product IS the pictures. The assertions that
 * back the same surfaces live in `tests/e2e/concepts.spec.ts`.
 *
 * Unlike the operator smokes beside it, this drives the BUNDLED chromium (no
 * `channel: "chrome"`), so it needs nothing installed beyond
 * `bun run --cwd apps/web test:e2e:install`.
 *
 * It expects a server already running. The isolated e2e stack is the intended
 * one, because it needs no credentials:
 *
 *   bun run --cwd apps/web scripts/e2e-stack.ts     # :3140, in another shell
 *   bun run --cwd apps/web concepts:evidence
 *
 * Point it elsewhere with CONCEPTS_BASE_URL.
 *
 * Covers get loaded from Fluncle's real image hosts, so a run with no network
 * still succeeds — the artwork falls back to the eclipse gradient, which is
 * exactly the resilience state the failure shots capture on purpose.
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(WEB_ROOT, "..", "..", "docs", "concepts", "discovery", "evidence");
const BASE = process.env.CONCEPTS_BASE_URL ?? "http://127.0.0.1:3140";

/** JPEG, never PNG: a public repo does not need retina lossless per view. */
const SHOT = { quality: 70, type: "jpeg" } as const;

/**
 * Full-page shots of a long board carry the most weight and need the least
 * detail, so they render below 1×. Keyboard shots stay at 1× — the whole point of
 * one is that the focus ring is legible.
 */
const FULL_PAGE_SCALE = 0.8;

const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };

type Shot = {
  /** Runs after load, before the picture: open a panel, press a key, focus something. */
  act?: (page: Page) => Promise<void>;
  concept: string;
  full?: boolean;
  name: string;
  path: string;
  /** What this picture is evidence OF, written into the manifest. */
  proves: string;
  reducedMotion?: boolean;
};

const SHOTS: Shot[] = [
  {
    concept: "exhibit",
    full: true,
    name: "index",
    path: "/concepts",
    proves: "The exhibit index: what each concept is for and where the data came from.",
  },

  // ── Concept A: the front page ───────────────────────────────────────────────
  {
    concept: "front",
    full: true,
    name: "zero-input",
    path: "/concepts/front",
    proves:
      "Zero-input discovery: a visitor who types nothing gets a lead, a column of recommendations, and what came out lately.",
  },
  {
    concept: "front",
    full: true,
    name: "seed-to-neighbour",
    path: "/concepts/front/track/090.6.2K",
    proves:
      "A known seed continues to unfamiliar sonic neighbours through the Close in sound block, with an accurate outbound destination on each row.",
  },
  {
    concept: "front",
    full: true,
    name: "entity-landing",
    path: "/concepts/front/on/label/hospital-records",
    proves:
      "A direct entity landing: identity and dossier, findings first, the rest unheaded, then the sonic step out.",
  },
  {
    act: async (page) => {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
    },
    concept: "front",
    name: "keyboard-focus",
    path: "/concepts/front",
    proves: "Keyboard operation: the focus ring is visible on the first reachable control.",
  },
  {
    concept: "front",
    name: "covers-unavailable",
    path: "/concepts/front",
    proves:
      "Resilient real-data loading: with every third-party cover host failing, the page keeps its structure and falls back to the eclipse gradient.",
  },

  // ── Concept B: the desk ─────────────────────────────────────────────────────
  {
    concept: "desk",
    full: true,
    name: "zero-input",
    path: "/concepts/desk",
    proves: "Zero-input discovery: the whole board with live facet counts and no query typed.",
  },
  {
    concept: "desk",
    full: true,
    name: "seed-to-neighbour",
    path: "/concepts/desk?soundsLike=090.6.2K",
    proves:
      "A known seed continues to unfamiliar sonic neighbours: the board holds Fluncle's own ranking around the anchor.",
  },
  {
    concept: "desk",
    full: true,
    name: "entity-landing",
    path: "/concepts/desk?label=Hospital+Records",
    proves: "A direct entity landing is the board pre-filled and headed by that entity.",
  },
  {
    concept: "desk",
    full: true,
    name: "empty",
    path: "/concepts/desk?q=zzzzzznothing",
    proves: "The empty state names what happened and offers a way back.",
  },
  {
    act: async (page) => {
      for (let press = 0; press < 6; press++) {
        await page.keyboard.press("Tab");
      }
    },
    concept: "desk",
    name: "keyboard-focus",
    path: "/concepts/desk",
    proves: "Keyboard operation: the focus ring is visible on a facet control.",
  },

  // ── Concept C: the run ──────────────────────────────────────────────────────
  {
    concept: "run",
    full: true,
    name: "zero-input",
    path: "/concepts/run",
    proves: "Zero-input discovery: the lane opens on a real record with branches ahead.",
  },
  {
    concept: "run",
    full: true,
    name: "entity-landing",
    path: "/concepts/run?entity=label:hospital-records",
    proves: "A direct entity landing opens the lane on what Fluncle holds at that node.",
  },
  {
    concept: "run",
    full: true,
    name: "reduced-motion",
    path: "/concepts/run",
    proves: "Under prefers-reduced-motion: reduce the lane still reads; nothing slides or fades.",
    reducedMotion: true,
  },
];

async function shoot(browser: Browser, shot: Shot, viewport: typeof DESKTOP): Promise<void> {
  const context = await browser.newContext({
    deviceScaleFactor: shot.full === true ? FULL_PAGE_SCALE : 1,
    reducedMotion: shot.reducedMotion === true ? "reduce" : "no-preference",
    viewport,
  });
  const page = await context.newPage();

  // The one deliberate failure case: kill every cover host so the fallback shows.
  if (shot.name === "covers-unavailable") {
    await page.route(/(found\.fluncle\.com|scdn\.co|coverartarchive\.org)/, (route) =>
      route.abort(),
    );
  }

  await page.goto(`${BASE}${shot.path}`, { timeout: 120_000, waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(900);

  if (shot.act) {
    await shot.act(page);
    await page.waitForTimeout(400);
  }

  const label = viewport === DESKTOP ? "desktop" : "mobile";

  await page.screenshot({
    ...SHOT,
    fullPage: shot.full === true,
    path: join(OUT_DIR, shot.concept, `${shot.name}-${label}.jpg`),
  });

  await context.close();
}

/**
 * The Run's argument is the state transition, and a still cannot carry it. This
 * takes an evenly spaced burst across one branch step and stitches the frames
 * into a filmstrip, then does the same run under `reduce` — the two strips beside
 * each other ARE the reduced-motion evidence.
 */
type Filmstrip = { dir: string; distinctFrames: number; frames: number };

async function filmstrip(browser: Browser, reduced: boolean): Promise<Filmstrip | undefined> {
  const context = await browser.newContext({
    reducedMotion: reduced ? "reduce" : "no-preference",
    viewport: DESKTOP,
  });
  const page = await context.newPage();
  const frames: string[] = [];
  const dir = join(OUT_DIR, "run", reduced ? "frames-reduced" : "frames-motion");

  await page.goto(`${BASE}/concepts/run`, { timeout: 120_000, waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(900);

  const branch = page.locator("[data-run-branch]").first();

  if ((await branch.count()) === 0) {
    await context.close();

    return undefined;
  }

  await mkdir(dir, { recursive: true });
  await branch.click();

  for (let frame = 0; frame < 6; frame++) {
    const path = join(dir, `${String(frame).padStart(2, "0")}.jpg`);

    await page.screenshot({ ...SHOT, path });
    frames.push(path);
    await page.waitForTimeout(70);
  }

  await context.close();
  await contactSheet(dir, frames);

  // The frame COUNT is the machine-checkable half of the motion evidence: under
  // no-preference every frame of the burst differs because the cross-fade is in
  // flight, and under `reduce` the burst settles and the tail frames are
  // byte-identical because nothing is animating. A reader does not have to take
  // the pictures on trust.
  const digests = new Set<string>();

  for (const frame of frames) {
    digests.add(Bun.hash(await Bun.file(frame).bytes()).toString());
  }

  return { dir, distinctFrames: digests.size, frames: frames.length };
}

/**
 * Tiles the burst into one image, so the transition can be read at a glance
 * instead of by opening six files. ffmpeg is not a hard requirement: without it
 * the frames stand on their own and the sheet is simply absent.
 */
async function contactSheet(dir: string, frames: string[]): Promise<void> {
  if (frames.length === 0) {
    return;
  }

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-loglevel",
      "error",
      "-i",
      join(dir, "%02d.jpg"),
      "-filter_complex",
      "tile=3x2:margin=8:padding=8:color=0x090a0b,scale=1600:-1",
      "-frames:v",
      "1",
      `${dir}.jpg`,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );

  await proc.exited;
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { force: true, recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const manifest: { concept: string; desktop: string; mobile: string; proves: string }[] = [];

  for (const shot of SHOTS) {
    // A concept a sibling has not landed yet must not fail the whole capture: the
    // manifest records what was taken, and a missing view is visibly missing.
    try {
      await mkdir(join(OUT_DIR, shot.concept), { recursive: true });
      await shoot(browser, shot, DESKTOP);
      await shoot(browser, shot, PHONE);
      manifest.push({
        concept: shot.concept,
        desktop: `${shot.concept}/${shot.name}-desktop.jpg`,
        mobile: `${shot.concept}/${shot.name}-mobile.jpg`,
        proves: shot.proves,
      });
      console.log(`captured ${shot.concept}/${shot.name}`);
    } catch (error) {
      console.error(`FAILED ${shot.concept}/${shot.name}: ${String(error)}`);
    }
  }

  // Repo-relative, never absolute: this file is committed to a public repository
  // and a local checkout path is topology nobody outside needs.
  const relative = (strip: Filmstrip | undefined): Filmstrip | undefined =>
    strip === undefined ? undefined : { ...strip, dir: strip.dir.slice(OUT_DIR.length + 1) };

  const motion = relative(await filmstrip(browser, false));
  const reduced = relative(await filmstrip(browser, true));

  await browser.close();

  await writeFile(
    join(OUT_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        base: BASE,
        filmstrips: { motion, reduced },
        shots: manifest,
        viewports: { desktop: DESKTOP, mobile: PHONE },
      },
      null,
      2,
    )}\n`,
  );

  console.log(`PASS — evidence in ${OUT_DIR}`);
}

await main();
