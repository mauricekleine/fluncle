// Bundle + render a registered composition to an mp4 via Remotion SSR.

import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { type NostalgicCosmosProps } from "../remotion/types";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
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
  compositionId: string,
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
    // The eager Oxanium load is a delayRender; under several concurrent renders
    // (a batch of agents) the machine oversubscribes and the default ~28s window
    // trips. Give font load room — it's I/O wait, not compute.
    timeoutInMilliseconds: 120_000,
  });

  await renderMedia({
    chromiumOptions: { gl: "angle" },
    codec: "h264",
    composition,
    // These scenes are GLSL shaders over film grain — high entropy h264 can't
    // dedupe. crf 31 kept files tiny but the compression was visible (blocking in
    // the gradients, mushy grain); the operator's eye caught it. Quality wins over
    // bytes here: TikTok/IG re-encode from a clean source far better than from a
    // pre-degraded one. So crf 20 + lossless PNG intermediate frames (the JPEG
    // default baked banding in BEFORE the h264 pass). Files run larger (hundreds
    // of MB for 20s), still well inside the upload flow's limits.
    crf: 20,
    imageFormat: "png",
    inputProps,
    outputLocation: outputPath,
    serveUrl,
    // Same delayRender headroom as selectComposition (see above) — concurrent
    // batch renders oversubscribe and the default font-load window trips.
    timeoutInMilliseconds: 120_000,
    x264Preset: "slow",
  });

  return { compositionId: composition.id, outputPath };
}
