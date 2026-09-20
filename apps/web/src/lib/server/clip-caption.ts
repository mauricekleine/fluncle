import { buildCaptionForClip, type BuiltClipCaption } from "./clip-caption-builder";
import { getClip } from "./clips";

export type { BuiltClipCaption } from "./clip-caption-builder";

/** Build a stored clip's caption; a missing clip throws clip_not_found/404. */
export async function buildClipCaption(clipId: string): Promise<BuiltClipCaption> {
  return buildCaptionForClip(await getClip(clipId));
}
