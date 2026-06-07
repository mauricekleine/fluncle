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
): Promise<RenderResult> {
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  const composition = await selectComposition({
    id: COMPOSITION_ID,
    inputProps,
    serveUrl,
  });

  await renderMedia({
    codec: "h264",
    composition,
    inputProps,
    outputLocation: outputPath,
    serveUrl,
  });

  return { compositionId: composition.id, outputPath };
}
