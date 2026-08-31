// The concepts' text contrast, measured in CI rather than asserted in prose.
//
// This exists because a number nobody else can reproduce is not evidence. The
// local `concepts:contrast` command needs `turso` and `sqld` on PATH, which a
// reviewer's machine has no reason to carry — so the measurement runs HERE, in
// the hosted `Public flows (chromium)` job, on the stack that job already boots.
// The full table goes to the run log and to `contrast-report.json`, which the
// workflow uploads on every run, pass or fail.
//
// It also re-measures the committed report at `docs/concepts/discovery/evidence/
// contrast.json`, so the retained claim and the live surface cannot drift.

import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { blockExternalRequests } from "./browser";
import {
  AA,
  CONTRAST_SAMPLES,
  CONTRAST_VIEWPORT,
  type ContrastReading,
  formatReading,
  readContrast,
} from "./contrast";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The retained report, regenerated from a run and committed beside the pictures. */
const COMMITTED_REPORT = join(
  WEB_ROOT,
  "..",
  "..",
  "docs",
  "concepts",
  "discovery",
  "evidence",
  "contrast.json",
);

/** Where the run writes its own copy, for the workflow to upload as an artifact. */
const RUN_REPORT = join(WEB_ROOT, "test-results", "contrast-report.json");

// Measured with the ambient motion GROUNDED, for two reasons that point the same
// way. It makes the number reproducible: the sun-bloom breath cycles the
// backdrop's luminance over 48s, so an un-pinned run samples a different ground
// every time (two runs of this file differed by 0.3:1 before this). And it is the
// conservative case: the breath alternates 0.78 → 1 opacity, so a stopped bloom
// sits at its BRIGHTEST, which is the hardest ground the text ever has to clear.
test.use({ reducedMotion: "reduce" });

test("every concept surface clears WCAG AA against what is actually behind its text", async ({
  page,
}) => {
  // One test, twenty-six navigations, against a Vite DEV server that compiles each
  // route on first request. The suite's 90s default is sized for a single page;
  // this one legitimately needs the room, and keeping it as ONE test is what lets
  // it write a single report a reviewer can read.
  test.setTimeout(300_000);

  // Hermetic: the ground under every sampled line is the LOCAL cover backdrop and
  // the panes over it, so stubbing third-party covers changes nothing that is
  // measured here and makes the number reproducible off a cold runner.
  await blockExternalRequests(page);
  await page.setViewportSize(CONTRAST_VIEWPORT);

  const readings: ContrastReading[] = [];
  const missing: string[] = [];

  for (const sample of CONTRAST_SAMPLES) {
    // Re-navigated per sample rather than reused across samples on one path:
    // measuring MUTATES the DOM (it makes the ink transparent), so a second
    // sample on a stale page would photograph the first one's hole.
    await page.goto(sample.path, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(250);

    const reading = await readContrast(page, sample);

    if (reading === undefined) {
      missing.push(`${sample.path} :: ${sample.selector}`);
      continue;
    }

    readings.push(reading);
    console.log(formatReading(reading));
  }

  const report = {
    // Self-describing, because the committed copy is read by people who did not
    // run it: it has to say what produced it and how to produce it again.
    generatedBy: "apps/web/tests/e2e/concepts-contrast.spec.ts",
    lowest: Number(
      Math.min(...readings.flatMap((reading) => [reading.mean, reading.worst])).toFixed(2),
    ),
    // Rounded to two places: the figure a human reads, and a figure that does not
    // churn the committed report over sub-percent antialiasing noise.
    readings: readings.map((reading) => ({
      mean: Number(reading.mean.toFixed(2)),
      path: reading.path,
      selector: reading.selector,
      worst: Number(reading.worst.toFixed(2)),
    })),
    reproduceWith: "bunx playwright test concepts-contrast.spec.ts (apps/web)",
    sampleCount: readings.length,
    samplesDeclared: CONTRAST_SAMPLES.length,
    threshold: AA,
    viewport: CONTRAST_VIEWPORT,
  };

  await mkdir(dirname(RUN_REPORT), { recursive: true });
  await writeFile(RUN_REPORT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `\n${report.sampleCount} samples measured, lowest ${report.lowest}:1 against a ${AA}:1 floor`,
  );

  // Every declared sample must be ON the page. A selector that stopped resolving
  // is a silently unmeasured surface, which is the failure mode this check exists
  // to prevent.
  expect(missing, "every declared contrast sample resolves").toEqual([]);
  expect(readings.length).toBe(CONTRAST_SAMPLES.length);

  for (const reading of readings) {
    expect(reading.mean, `mean — ${reading.path} :: ${reading.selector}`).toBeGreaterThanOrEqual(
      AA,
    );
    expect(
      reading.worst,
      `worst tile — ${reading.path} :: ${reading.selector}`,
    ).toBeGreaterThanOrEqual(AA);
  }

  // The retained claim is checked against this run, not trusted. Ratios are
  // compared loosely (a runner and a laptop antialias differently); the sample
  // COUNT and the floor are compared exactly, because those are what the
  // comparison document quotes.
  const committed = JSON.parse(await readFile(COMMITTED_REPORT, "utf8")) as typeof report;

  expect(committed.threshold, "the retained report quotes this floor").toBe(AA);
  expect(committed.sampleCount, "the retained report quotes this sample count").toBe(
    readings.length,
  );
  expect(
    committed.lowest,
    "the retained lowest ratio still clears the floor",
  ).toBeGreaterThanOrEqual(AA);
});
