import { initWasm, Resvg } from "@resvg/resvg-wasm";
// The wasm module rides the Worker bundle exactly the way workers-og carries its own copy —
// a static .wasm import the Cloudflare vite build compiles in. No runtime fetch.
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

// The SVG → raw-RGBA raster for in-Worker image encoding (the Frontier cover's JPEG leg).
// workers-og's bundled resvg only ever hands back finished PNG bytes; this module runs OUR OWN
// resvg instance so the raw pixel buffer is available to a JPEG encoder — the piece that lets a
// cover be encoded entirely inside the Worker, with no staging round-trip through R2 + a zone
// transform (a Worker cannot fetch its own zone's R2 custom domain; see frontier-cover.ts).
//
// This module is WORKER-ONLY (the .wasm import does not resolve under vitest/node) — reach it
// through a lazy `await import(...)`, the workers-og discipline.

let ready: Promise<void> | undefined;

/** Rasterise an SVG to raw RGBA pixels at `width`. Initialises the wasm once per isolate. */
export async function rasterSvgToPixels(
  svg: string,
  width: number,
): Promise<{ height: number; pixels: Uint8Array; width: number }> {
  ready ??= initWasm(resvgWasm);
  await ready;

  const rendered = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();

  return { height: rendered.height, pixels: rendered.pixels, width: rendered.width };
}
