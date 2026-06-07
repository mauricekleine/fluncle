// Bundle + render the "NostalgicCosmos" composition to an mp4 via Remotion SSR.

import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { type NostalgicCosmosProps } from "../remotion/types";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const COMPOSITION_ID = "NostalgicCosmos";

export type RenderResult = {
  outputPath: string;
  compositionId: string;
};

/**
 * Render the composition with the given inputProps to `outputPath` (h264 mp4).
 * Audio is carried by the composition via props.audio.file + staticFile().
 */
export async function render(
  inputProps: NostalgicCosmosProps,
  outputPath: string,
  compositionId: string = COMPOSITION_ID,
): Promise<RenderResult> {
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  const composition = await selectComposition({
    // GPU shaders: ANGLE (Metal on Apple Silicon) gives WebGL a real hardware
    // context headlessly, matching remotion.config.ts for Studio/CLI parity.
    chromiumOptions: { gl: "angle" },
    id: compositionId,
    inputProps,
    serveUrl,
  });

  await renderMedia({
    chromiumOptions: { gl: "angle" },
    codec: "h264",
    composition,
    // These scenes are GLSL shaders drowned in film grain and dither — pure
    // entropy that h264 can't dedupe, so Remotion's default crf of 18 ballooned
    // a 20s clip to 254MB. Grain also hides compression artifacts, so we can
    // push crf hard with no perceptible loss (social platforms re-encode anyway).
    // crf 31 + the "slow" preset projects ~32MB for 20s, well under our 40MB
    // budget, vs ~144MB at crf 24. "slow" buys real bytes on high-entropy frames.
    crf: 31,
    inputProps,
    outputLocation: outputPath,
    serveUrl,
    x264Preset: "slow",
  });

  return { compositionId: composition.id, outputPath };
}
