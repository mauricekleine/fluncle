// The contrast measurement, shared by the hosted spec and the local CLI.
//
// Contrast on the concept surfaces cannot be read off the palette. Every pane is
// translucent over the cover-art backdrop and the sun bloom, so what sits behind
// a line of text is a composite the stylesheet never names (DESIGN.md, The
// Legible Sky Rule: AA is verified against what is ACTUALLY behind the text,
// texture included). So this photographs it: hide the ink, keep the layout,
// screenshot the element's own box, and compute the ratio against the computed
// colour.
//
// The samples and the maths live HERE rather than in either caller, so the
// number CI publishes and the number a laptop prints can never drift apart —
// which is the whole point of the check being citable.
//
// Pixel reading is done by the browser's own canvas rather than an image
// library, so this needs no dependency the repo does not already have.

import { type Page } from "@playwright/test";

/** WCAG AA for body text. Large text would pass at 3:1; nothing here relies on that. */
export const AA = 4.5;

/**
 * A translucent pane over a photograph is not one ground, it is a gradient of
 * them, so an AVERAGE can clear AA while a bright band under one word does not.
 * Each sample is therefore scored on its worst tile as well as its mean.
 */
const TILE = 6;

export type ContrastSample = { path: string; selector: string };

/**
 * One sample per distinct ink-on-ground pairing the three concepts render.
 *
 * Every selector must resolve to an element whose box holds TEXT and nothing
 * else. A box that also contains an image is measuring the artwork rather than
 * the ground, and its worst tile means nothing.
 */
export const CONTRAST_SAMPLES: ContrastSample[] = [
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

/** The viewport every measurement is taken at, so a number is comparable. */
export const CONTRAST_VIEWPORT = { height: 900, width: 1440 };

export type ContrastReading = {
  mean: number;
  path: string;
  selector: string;
  worst: number;
};

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

    for (const child of [node, ...node.querySelectorAll("*")]) {
      if (child instanceof HTMLElement) {
        child.style.color = "transparent";
        child.style.textDecorationColor = "transparent";
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
      const black: [number, number, number] = [0, 0, 0];

      if (context === null) {
        return { mean: black, worst: black };
      }

      context.drawImage(image, 0, 0);

      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const at = (x: number, y: number): number => (y * canvas.width + x) * 4;
      const tiles: [number, number, number][] = [];
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
      const mean: [number, number, number] = [
        Math.round(red / pixels),
        Math.round(green / pixels),
        Math.round(blue / pixels),
      ];
      // The worst tile is the one whose luminance sits furthest from the mean:
      // whichever direction the ink is coming from, that tile is the hardest.
      const luminance = (c: [number, number, number]): number =>
        0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const meanY = luminance(mean);
      const worst =
        tiles.length === 0
          ? mean
          : tiles.reduce((far, candidate) =>
              Math.abs(luminance(candidate) - meanY) > Math.abs(luminance(far) - meanY)
                ? candidate
                : far,
            );

      return { mean, worst };
    },
    { source: dataUrl, tile: TILE },
  );
}

/**
 * Measure one sample on an already-navigated page. Returns `undefined` when the
 * selector is not on the page, so a caller can report the gap rather than
 * silently scoring nothing.
 */
export async function readContrast(
  page: Page,
  sample: ContrastSample,
): Promise<ContrastReading | undefined> {
  const element = page.locator(sample.selector).first();

  if ((await element.count()) === 0) {
    return undefined;
  }

  const ink = parseRgb(await element.evaluate((node) => getComputedStyle(node).color));
  const ground = await groundUnder(page, sample.selector);

  if (ink === undefined || ground === undefined) {
    return undefined;
  }

  return {
    mean: contrast(ink, ground.mean),
    path: sample.path,
    selector: sample.selector,
    worst: contrast(ink, ground.worst),
  };
}

/** One printed line, identical in CI and on a laptop. */
export function formatReading(reading: ContrastReading): string {
  return (
    `${reading.mean.toFixed(2).padStart(6)}:1 mean  ` +
    `${reading.worst.toFixed(2).padStart(6)}:1 worst tile  ` +
    `${reading.path} :: ${reading.selector}`
  );
}
