import { buildCaptionForClip, type BuiltClipCaption } from "./clip-caption-builder";
import { getClip } from "./clips";

export type { BuiltClipCaption } from "./clip-caption-builder";

export async function buildClipCaption(clipId: string): Promise<BuiltClipCaption> {
  return buildCaptionForClip(await getClip(clipId));
}
