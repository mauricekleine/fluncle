// The render-flag provenance for the two-master video bundle (see
// docs/video-variants.md). The two masters are the SAME composition + props
// rendered with DIFFERENT flags; recording those flags per output in render.json
// is what lets a future "clean re-render from source" reproduce the right cut
// instead of naively re-rendering the portrait default. Every writer of the
// bundle render.json derives its `variants` map from here so they cannot drift.

import { type RenderVariant, type RenderVariants } from "./types";

/** The clean square crop-source master: aspect=square, overlay suppressed. */
const FOOTAGE: RenderVariant = { aspect: "square", hideOverlay: true };

/** The portrait baked-text social cut: the default flags. */
const FOOTAGE_SOCIAL: RenderVariant = { aspect: "portrait", hideOverlay: false };

/** The canonical output filenames for the two masters. */
export const FOOTAGE_FILENAME = "footage.mp4";
export const FOOTAGE_SOCIAL_FILENAME = "footage.social.mp4";

/**
 * Build the `variants` provenance map for a bundle render.json. Pass only the
 * masters the writer actually produced — a writer that emits just one master
 * records just that one entry (never fabricate a master it didn't render).
 * Defaults to both masters (the full two-master bundle).
 */
export function buildVariants(
  masters: {
    footage?: boolean;
    footageSocial?: boolean;
  } = {},
): RenderVariants {
  const { footage = true, footageSocial = true } = masters;
  const variants: RenderVariants = {};
  if (footage) {
    variants[FOOTAGE_FILENAME] = FOOTAGE;
  }
  if (footageSocial) {
    variants[FOOTAGE_SOCIAL_FILENAME] = FOOTAGE_SOCIAL;
  }
  return variants;
}
