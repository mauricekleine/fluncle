// The render-flag provenance for the two-master video bundle.
// The two masters are the SAME composition + props
// rendered with DIFFERENT flags; recording those flags per output in render.json
// is what lets a future "clean re-render from source" reproduce the right cut
// instead of naively re-rendering the portrait default. Every writer of the
// bundle render.json derives its `variants` map from here so they cannot drift.

import { type RenderVariant, type RenderVariants } from "./types";

/** The clean square crop-source master: aspect=square, overlay suppressed. */
const FOOTAGE: RenderVariant = { aspect: "square", hideOverlay: true };

/** The portrait baked-text social cut: the default flags. */
const FOOTAGE_SOCIAL: RenderVariant = { aspect: "portrait", hideOverlay: false };

/**
 * The clean landscape escape hatch (docs/video-variants.md "The square-crop
 * quality dial"): a dedicated 16:9 render for a finding whose square-crop
 * doesn't hold up (an off-centre vehicle). Not auto-produced — an operator
 * renders it explicitly when the crop fails the eye test.
 */
const FOOTAGE_LANDSCAPE: RenderVariant = { aspect: "landscape", hideOverlay: true };

/** The baked-text landscape cut — a landscape social render, if ever produced. */
const FOOTAGE_LANDSCAPE_SOCIAL: RenderVariant = { aspect: "landscape", hideOverlay: false };

/**
 * The clean portrait, text-free cut. Largely superseded by MT-cropping the
 * square `footage.mp4` (see docs/video-variants.md) once a finding is squared,
 * but packaged if a writer produced one explicitly (e.g. a pre-square render).
 */
const FOOTAGE_NOTEXT: RenderVariant = { aspect: "portrait", hideOverlay: true };

/** The canonical output filenames for the two masters. */
export const FOOTAGE_FILENAME = "footage.mp4";
export const FOOTAGE_SOCIAL_FILENAME = "footage.social.mp4";

/** The canonical output filenames for the optional extra variants (§ above). */
export const FOOTAGE_LANDSCAPE_FILENAME = "footage.landscape.mp4";
export const FOOTAGE_LANDSCAPE_SOCIAL_FILENAME = "footage.landscape.social.mp4";
export const FOOTAGE_NOTEXT_FILENAME = "footage.notext.mp4";

/**
 * Build the `variants` provenance map for a bundle render.json. Pass only the
 * masters the writer actually produced — a writer that emits just one master
 * records just that one entry (never fabricate a master it didn't render).
 * Defaults to the two-master bundle (`footage`/`footageSocial`); the extra
 * variants default OFF since most bundles never produce them.
 */
export function buildVariants(
  masters: {
    footage?: boolean;
    footageSocial?: boolean;
    footageLandscape?: boolean;
    footageLandscapeSocial?: boolean;
    footageNotext?: boolean;
  } = {},
): RenderVariants {
  const {
    footage = true,
    footageSocial = true,
    footageLandscape = false,
    footageLandscapeSocial = false,
    footageNotext = false,
  } = masters;
  const variants: RenderVariants = {};
  if (footage) {
    variants[FOOTAGE_FILENAME] = FOOTAGE;
  }
  if (footageSocial) {
    variants[FOOTAGE_SOCIAL_FILENAME] = FOOTAGE_SOCIAL;
  }
  if (footageLandscape) {
    variants[FOOTAGE_LANDSCAPE_FILENAME] = FOOTAGE_LANDSCAPE;
  }
  if (footageLandscapeSocial) {
    variants[FOOTAGE_LANDSCAPE_SOCIAL_FILENAME] = FOOTAGE_LANDSCAPE_SOCIAL;
  }
  if (footageNotext) {
    variants[FOOTAGE_NOTEXT_FILENAME] = FOOTAGE_NOTEXT;
  }
  return variants;
}
