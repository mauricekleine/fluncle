import { parseSrt } from "@remotion/captions";

import { type CaptionLine } from "./types";

export const srtToCaptionLines = (input: string): CaptionLine[] => {
  const { captions } = parseSrt({ input: input.trim() });
  return captions.map((caption) => ({
    fromMs: caption.startMs,
    text: caption.text,
    toMs: caption.endMs,
  }));
};
