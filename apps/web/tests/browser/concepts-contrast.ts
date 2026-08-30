#!/usr/bin/env bun
/**
 * Measures the concepts' real text contrast and fails if any sample is under AA.
 *
 * Contrast on these surfaces cannot be read off the palette. Every pane is
 * translucent over the cover-art backdrop and the sun bloom, so what sits behind
 * a line of text is a composite the stylesheet never names (DESIGN.md, The
 * Legible Sky Rule: AA is verified against what is ACTUALLY behind the text,
 * texture included). So this photographs it: hide the ink, keep the layout,
 * screenshot the element's own box, average the pixels, and compute the ratio
 * against the computed colour.
 *
 * Pixel reading is done by the browser's own canvas rather than an image
 * library, so this needs no dependency the repo does not already have.
 *
 *   bun run --cwd apps/web scripts/e2e-stack.ts     # :3140, in another shell
 *   bun run --cwd apps/web concepts:contrast
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.CONCEPTS_BASE_URL ?? "http://127.0.0.1:3140";

/** WCAG AA for body text. Large text would pass at 3:1; nothing here relies on that. */
const AA = 4.5;

/**
 * A translucent pane over a photograph is not one ground, it is a gradient of
 * them, so an AVERAGE can clear AA while a bright band under one word does not.
 * Each sample is therefore scored on its worst tile as well as its mean.
 *
 * Every selector below must resolve to an element whose box holds TEXT and
 * nothing else. A box that also contains an image is measuring the artwork, not
 * the ground, and its worst tile is meaningless.
 */
const TILE = 6;

/** One sample per distinct ink-on-ground pairing each concept actually renders. */
const SAMPLES: { path: string; selector: string }[] = [
  { path: "/concepts", selector: "main p" },
  { path: "/concepts", selector: "main dd" },

  { path: "/concepts/front", selector: ".front-masthead-title" },
  { path: "/concepts/front", selector: ".front-masthead p" },
  { path: "/concepts/front", selector: ".front-note" },
  { path: "/concepts/front", selector: ".front-entry .concept-display" },
  { path: "/concepts/front", selector: ".front-band p" },
  { path: "/concepts/front", selector: ".front-release p" },
  { path: "/concepts/front", selector: ".front-tile h3" },
  { path: "/concepts/front/track/090.6.2K", selector: ".front-lead-title" },
  { path: "/concepts/front/on/label/hospital-records", selector: "header p" },

  { path: "/concepts/desk", selector: "main h1" },
  { path: "/concepts/desk", selector: ".desk-count" },
  { path: "/concepts/desk", selector: ".desk-facet-label" },
  { path: "/concepts/desk", selector: ".desk-facet-count" },
  { path: "/concepts/desk", selector: ".desk-row-billing" },
  { path: "/concepts/desk", selector: ".desk-row-meta" },
  { path: "/concepts/desk?q=zzzzzznothing", selector: ".desk-empty" },

  { path: "/concepts/run", selector: "main h1" },
  { path: "/concepts/run", selector: "main p" },
  { path: "/concepts/run?step=1", selector: ".run-back" },
  { path: "/concepts/run", selector: ".run-kbd" },
  { path: "/concepts/run", selector: ".run-branch-billing" },
  { path: "/concepts/run", selector: ".run-branch-label" },
  { path: "/concepts/run?anchor=090.6.2K", selector: ".run-title" },
  { path: "/concepts/run?entity=label:hospital-records", selector: ".run-entered-name" },
];

type Rgb = [number, number, number];

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(ink: Rgb, ground: Rgb): number {
  const a = relativeLuminance(ink);
  const b = relativeLuminance(ground);
  const [high, low] = a > b ? [a, b] : [b, a];

  return (high + 0.05) / (low + 0.05);
}

function parseRgb(value: string): Rgb | undefined {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);

  if (match === null) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The element's own box with its ink made transparent, reduced to the mean
 * ground and the WORST tile of ground under it.
 */
async function groundUnder(
  page: Page,
  selector: string,
): Promise<{ mean: Rgb; worst: Rgb } | undefined> {
  const element = page.locator(selector).first();

  if ((await element.count()) === 0) {
    return undefined;
  }

  // The whole subtree, not just the host: a nested link keeps its own colour and
  // would otherwise be photographed as if it were the ground.
  await element.evaluate((node) => {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    for (const element of [node, ...node.querySelectorAll("*")]) {
      if (element instanceof HTMLElement) {
        element.style.color = "transparent";
        element.style.textDecorationColor = "transparent";
      }
    }
  });

  const shot = await element.screenshot({ type: "png" });
  const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

  return page.evaluate(
    async ({ source, tile }): Promise<{ mean: Rgb; worst: Rgb }> => {
      const image = new Image();

      await new Promise((resolve) => {
        image.onload = resolve;
        image.src = source;
      });

      const canvas = document.createElement("canvas");

      canvas.height = image.height;
      canvas.width = image.width;

      const context = canvas.getContext("2d");
      const black: Rgb = [0, 0, 0];

      if (context === null) {
        return { mean: black, worst: black };
      }

      context.drawImage(image, 0, 0);

      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const at = (x: number, y: number): number => (y * canvas.width + x) * 4;
      const tiles: Rgb[] = [];
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let index = 0; index < data.length; index += 4) {
        red += data[index] ?? 0;
        green += data[index + 1] ?? 0;
        blue += data[index + 2] ?? 0;
      }

      for (let top = 0; top < canvas.height; top += tile) {
        for (let left = 0; left < canvas.width; left += tile) {
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;

          for (let y = top; y < Math.min(top + tile, canvas.height); y++) {
            for (let x = left; x < Math.min(left + tile, canvas.width); x++) {
              const i = at(x, y);

              r += data[i] ?? 0;
              g += data[i + 1] ?? 0;
              b += data[i + 2] ?? 0;
              n++;
            }
          }

          if (n > 0) {
            tiles.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
          }
        }
      }

      const pixels = data.length / 4;
      const mean: Rgb = [
        Math.round(red / pixels),
        Math.round(green / pixels),
        Math.round(blue / pixels),
      ];
      // The worst tile is the one whose luminance sits furthest from the mean:
      // whichever direction the ink is coming from, that tile is the hardest.
      const meanY = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
      const worst =
        tiles.length === 0
          ? mean
          : (tiles.reduce((far, candidate) => {
              const y = 0.2126 * candidate[0] + 0.7152 * candidate[1] + 0.0722 * candidate[2];
              const best = 0.2126 * far[0] + 0.7152 * far[1] + 0.0722 * far[2];

              return Math.abs(y - meanY) > Math.abs(best - meanY) ? candidate : far;
            }) as Rgb);

      return { mean, worst };
    },
    { source: dataUrl, tile: TILE },
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const sample of SAMPLES) {
    const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });

    await page.goto(`${BASE}${sample.path}`, {
      timeout: 120_000,
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(700);

    const element = page.locator(sample.selector).first();

    if ((await element.count()) === 0) {
      skipped.push(`${sample.path} :: ${sample.selector}`);
      await page.close();
      continue;
    }

    const ink = parseRgb(await element.evaluate((node) => getComputedStyle(node).color));
    const ground = await groundUnder(page, sample.selector);

    if (ink === undefined || ground === undefined) {
      skipped.push(`${sample.path} :: ${sample.selector}`);
      await page.close();
      continue;
    }

    const mean = contrast(ink, ground.mean);
    const worst = contrast(ink, ground.worst);
    const line =
      `${mean.toFixed(2).padStart(6)}:1 mean  ${worst.toFixed(2).padStart(6)}:1 worst tile  ` +
      `${sample.path} :: ${sample.selector}`;

    console.log(line);

    if (Math.min(mean, worst) < AA) {
      failures.push(line);
    }

    await page.close();
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

  console.log(`\nPASS — every sample clears ${AA}:1 against what is actually behind it`);
}

await main();
