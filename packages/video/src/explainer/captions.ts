// The production caption route. Record the VO, transcribe it to an SRT (whisper
// or by hand), and hand the string to the manifest as `captionsSrt`. @remotion/
// captions parses it into absolute-timed lines the Captions overlay renders.
// The per-chapter inline captions in the manifest are only the preview stand-in.

import { parseSrt } from "@remotion/captions";

import { type CaptionLine } from "./types";

/** Parse an .srt transcript into the Explainer's absolute-timed caption lines. */
export const srtToCaptionLines = (input: string): CaptionLine[] => {
  const { captions } = parseSrt({ input: input.trim() });
  return captions.map((caption) => ({
    fromMs: caption.startMs,
    text: caption.text,
    toMs: caption.endMs,
  }));
};
