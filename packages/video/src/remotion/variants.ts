import { type RenderVariant, type RenderVariants } from "./types";

const FOOTAGE: RenderVariant = { aspect: "square", hideOverlay: true };

const FOOTAGE_SOCIAL: RenderVariant = { aspect: "portrait", hideOverlay: false };

const FOOTAGE_LANDSCAPE: RenderVariant = { aspect: "landscape", hideOverlay: true };

const FOOTAGE_LANDSCAPE_SOCIAL: RenderVariant = { aspect: "landscape", hideOverlay: false };

const FOOTAGE_NOTEXT: RenderVariant = { aspect: "portrait", hideOverlay: true };

export const FOOTAGE_FILENAME = "footage.mp4";
export const FOOTAGE_SOCIAL_FILENAME = "footage.social.mp4";

export const FOOTAGE_LANDSCAPE_FILENAME = "footage.landscape.mp4";
export const FOOTAGE_LANDSCAPE_SOCIAL_FILENAME = "footage.landscape.social.mp4";
export const FOOTAGE_NOTEXT_FILENAME = "footage.notext.mp4";

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
