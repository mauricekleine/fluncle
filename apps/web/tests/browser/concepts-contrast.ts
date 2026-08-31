#!/usr/bin/env bun
/**
 * The concepts' contrast check, run by hand against an already-running stack.
 *
 * This is the LOCAL convenience wrapper. The measurement itself — the samples,
 * the maths, the AA floor — lives in `tests/e2e/contrast.ts`, and the check that
 * anyone can cite runs in CI as `tests/e2e/concepts-contrast.spec.ts` inside the
 * hosted `Public flows (chromium)` job. Nothing is duplicated here, so a laptop
 * and a runner cannot disagree about what was measured.
 *
 * Use this when iterating on the surfaces; use the CI run as evidence.
 *
 *   bun run --cwd apps/web scripts/e2e-stack.ts     # :3140, in another shell
 *   bun run --cwd apps/web concepts:contrast
 *
 * Point it elsewhere with CONCEPTS_BASE_URL. It needs `turso` and `sqld` on PATH
 * for that stack; a reviewer without them should read the CI log instead.
 */
import { chromium } from "playwright";

import {
  AA,
  CONTRAST_SAMPLES,
  CONTRAST_VIEWPORT,
  type ContrastReading,
  formatReading,
  readContrast,
} from "../e2e/contrast";

const BASE = process.env.CONCEPTS_BASE_URL ?? "http://127.0.0.1:3140";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const failures: string[] = [];
  const skipped: string[] = [];
  const readings: ContrastReading[] = [];

  for (const sample of CONTRAST_SAMPLES) {
    // Grounded, exactly as the CI spec measures: the sun-bloom breath would
    // otherwise move the ground between samples, and a stopped bloom sits at its
    // brightest — the hardest case for the ink.
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: CONTRAST_VIEWPORT,
    });

    await page.goto(`${BASE}${sample.path}`, {
      timeout: 120_000,
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(700);

    const reading = await readContrast(page, sample);

    await page.close();

    if (reading === undefined) {
      skipped.push(`${sample.path} :: ${sample.selector}`);
      continue;
    }

    readings.push(reading);

    const line = formatReading(reading);

    console.log(line);

    if (Math.min(reading.mean, reading.worst) < AA) {
      failures.push(line);
    }
  }

  await browser.close();

  for (const missing of skipped) {
    console.log(`  skipped (not on the page): ${missing}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} sample(s) under ${AA}:1`);
    failures.forEach((failure) => console.error(failure));
    process.exit(1);
  }

  const lowest = Math.min(...readings.flatMap((reading) => [reading.mean, reading.worst]));

  console.log(
    `\nPASS — ${readings.length} samples, lowest ${lowest.toFixed(2)}:1 against a ${AA}:1 floor, ` +
      `measured against what is actually behind the text`,
  );
}

await main();
