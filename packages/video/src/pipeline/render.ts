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
    // dedupe, so grain saturates whatever bitrate it's given. crf 31 was blocky
    // (mushy grain, banding in the gradients); uncapped crf 20 fixed the look but
    // ballooned a 20s clip to ~200MB. The size lever for this content isn't crf,
    // it's a VBV CAP: encodingMaxRate bounds the peak the grain can spend, so the
    // file size is predictable regardless of how busy the frame is.
    //
    // 32 Mbit/s × 20s ≈ 80MB — comfortably under the 100MB ceiling that unlocks
    // Cloudflare Media Transformations (the on-the-fly web rendition off the R2
    // master). lossless PNG intermediates stay (JPEG baked banding in BEFORE the
    // h264 pass). crf is the quality target under the cap; both crf and the cap
    // are first-pass values to A/B-verify by eye on the next render batch (grain
    // is load-bearing — the Light-Years Rule — so the cap can't go so low it
    // re-introduces blocking).
    crf: 23,
    encodingBufferSize: "64M",
    encodingMaxRate: "32M",
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
