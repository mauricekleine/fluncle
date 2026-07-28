// Render the App Store screenshot art — one own-IP sleeve per synthetic finding and one
// own-IP artist mark per synthetic artist.
//
//   bun run render:screenshot-assets                 (all of them)
//   bun run render:screenshot-assets -- --only saltglass   (one, by slug — for a quick look)
//
// STEP 1 of the 5.2.1 re-shoot (docs/mobile-store-screenshots.md). Mobile 1.0 was rejected
// because the store screenshots showed real album covers and Spotify artist photos; this
// renders the replacements Fluncle owns outright. Step 2 serves `out/screenshot-assets`
// over HTTP, step 3 seeds the local dev DB with rows pointing at it
// (`bun run --cwd apps/web screenshot:seed`), step 4 shoots the simulator against it.
//
// The fixture list is `@fluncle/test-support/screenshot-fixtures` — the SAME module the
// seed reads, so a rendered file name and a seeded `albumImageUrl` can never disagree.
//
// Output lands in `out/`, which is gitignored: these are working assets for a capture
// session, not committed brand files. Mirrors render-app-icons.ts otherwise — bundle the
// registry once, then select + renderStill each fixture through ANGLE (hardware GL) so
// @remotion/fonts' loadFont settles.

import fs from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { SCREENSHOT_ARTISTS, SCREENSHOT_FINDINGS } from "@fluncle/test-support/screenshot-fixtures";

import {
  SCREENSHOT_ASSET_OUT_DIR,
  SYNTHETIC_AVATAR_ID,
  SYNTHETIC_SLEEVE_ID,
} from "../remotion/screenshot-asset-specs";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const OUT_DIR = path.resolve(import.meta.dirname, "../..", SCREENSHOT_ASSET_OUT_DIR);
const CHROMIUM_OPTIONS = { gl: "angle" } as const;

/** One still to render: which composition, which props, which file. */
type AssetJob = {
  compositionId: string;
  inputProps: Record<string, string>;
  kind: "avatar" | "sleeve";
  slug: string;
};

/** Parse `--only <slug>` from argv (renders just that sleeve or avatar). */
function parseOnly(argv: string[]): string | undefined {
  const index = argv.indexOf("--only");

  return index === -1 ? undefined : argv[index + 1];
}

/** Every job the fixture list implies, sleeves first. */
function buildJobs(): AssetJob[] {
  const sleeves: AssetJob[] = SCREENSHOT_FINDINGS.map((finding) => ({
    compositionId: SYNTHETIC_SLEEVE_ID,
    inputProps: {
      artist:
        SCREENSHOT_ARTISTS.find((artist) => artist.slug === finding.artistSlug)?.name ??
        finding.artistSlug,
      seed: finding.slug,
      title: finding.title,
    },
    kind: "sleeve",
    slug: finding.slug,
  }));

  const avatars: AssetJob[] = SCREENSHOT_ARTISTS.map((artist) => ({
    compositionId: SYNTHETIC_AVATAR_ID,
    inputProps: { name: artist.name, seed: artist.slug },
    kind: "avatar",
    slug: artist.slug,
  }));

  return [...sleeves, ...avatars];
}

async function renderScreenshotAssets(only: string | undefined): Promise<void> {
  const jobs = buildJobs().filter((job) => !only || job.slug === only);

  if (jobs.length === 0) {
    throw new Error(
      `no screenshot asset matches --only ${only ?? ""} (check the slug against @fluncle/test-support/screenshot-fixtures)`,
    );
  }

  await fs.mkdir(path.join(OUT_DIR, "sleeves"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "avatars"), { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  for (const job of jobs) {
    const composition = await selectComposition({
      chromiumOptions: CHROMIUM_OPTIONS,
      id: job.compositionId,
      inputProps: job.inputProps,
      serveUrl,
    });
    const output = path.join(OUT_DIR, `${job.kind}s`, `${job.slug}.png`);

    await renderStill({
      chromiumOptions: CHROMIUM_OPTIONS,
      composition,
      frame: 0,
      imageFormat: "png",
      inputProps: job.inputProps,
      output,
      serveUrl,
    });

    console.error(`[screenshot-assets] ${composition.width}×${composition.height} -> ${output}`);
  }

  console.error(
    `[screenshot-assets] ${jobs.length} asset(s) in ${OUT_DIR} — serve this directory on :8899 before seeding.`,
  );
}

if (import.meta.main) {
  renderScreenshotAssets(parseOnly(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
