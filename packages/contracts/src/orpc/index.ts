// The runtime oRPC contract registry — the contract-first source of truth the
// oRPC migration is built on (docs/orpc-migration-brief.md). This is the
// `@fluncle/contracts/orpc` subpath entry.
//
// The pure-types `../index.ts` is the package's ZOD-FREE surface: the CLI,
// Raycast, and the browser extension import it and must never pull zod/@orpc
// into their bundles. This subpath is the *runtime* contract layer — `@orpc`
// ops whose I/O are Zod schemas — kept apart so those pure-types consumers stay
// clean. From these contracts derive, in one place that cannot disagree: the
// request/response validators, the typed `Router` client, and the generated
// OpenAPI document.
//
// COMPOSABLE BY DOMAIN. Each domain owns one module (`./tracks.ts`,
// `./health.ts`, …) exporting its ops; this root merges them into the single
// flat `contract` object. A new wave adds `./<domain>.ts` + one spread line
// here — it touches no other domain's file, so parallel agents converting
// different domains never collide.
//
// Naming follows the ratified Convention B (docs/naming-conventions.md): each op
// has a canonical `verb_noun` registry key whose camelCase projection is the
// OpenAPI `operationId` (`get_track` → `getTrack`). The REST path mirrors the
// live route; resources are plural, the op noun stays singular.

import { adminBackfillsContract } from "./admin-backfills";
import { adminEditionsContract } from "./admin-editions";
import { adminMixtapesContract } from "./admin-mixtapes";
import { adminSocialContract } from "./admin-social";
import { adminSubmissionsContract } from "./admin-submissions";
import { adminTokensContract } from "./admin-tokens";
import { adminTracksContract } from "./admin-tracks";
import { devicesContract } from "./devices";
import { editionsContract } from "./editions";
import { healthContract } from "./health";
import { meContract } from "./me";
import { meGalaxyContract } from "./me-galaxy";
import { meSavedContract } from "./me-saved";
import { mixtapesContract } from "./mixtapes";
import { newsletterContract } from "./newsletter";
import { radioContract } from "./radio";
import { searchContract } from "./search";
import { storiesContract } from "./stories";
import { submissionsContract } from "./submissions";
import { tracksContract } from "./tracks";

// Re-export the per-op contracts so existing importers (and the typed client)
// keep their entrypoints.
export { backfillDiscogs, backfillLastfm } from "./admin-backfills";
export { createEdition, listEditionsAdmin, sendEdition, updateEdition } from "./admin-editions";
export {
  addMixtapeMembers,
  createMixtape,
  deleteMixtape,
  finalizeMixtapeMixcloud,
  finalizeMixtapeYoutube,
  getMixtapeSocial,
  initiateMixtapeYoutube,
  listMixtapesAdmin,
  publishMixtape,
  publishMixtapeYoutube,
  setMixtapeMembers,
  updateMixtape,
} from "./admin-mixtapes";
export { draftTrackSocial, listTrackSocial, updateTrackSocial } from "./admin-social";
export { deregisterDevice, registerDevice, sweepPushReceipts } from "./devices";
export { getEdition, listEditions } from "./editions";
export {
  approveSubmission,
  getSubmission,
  listSubmissions,
  rejectSubmission,
} from "./admin-submissions";
export {
  exchangeLastfmSession,
  mintMixcloudToken,
  mintYoutubeToken,
  startLastfmAuth,
} from "./admin-tokens";
export {
  contextTrack,
  finalizeTrackVideo,
  listTracksAdmin,
  observeTrack,
  presignTrackVideoUploads,
  publishTrack,
  updateTrack,
} from "./admin-tracks";
export { getHealth } from "./health";
export {
  deletePrivateAccount,
  exportPrivateAccountData,
  getCurrentPrivateUser,
  getPrivateAccountExport,
  getPrivateMutationToken,
  listPrivateSubmissions,
  updatePrivateProfile,
} from "./me";
export {
  collectPrivateGalaxyLog,
  getPrivateGalaxyProgress,
  mergePrivateGalaxyProgress,
} from "./me-galaxy";
export { listPrivateSavedFindings, savePrivateFinding, unsavePrivateFinding } from "./me-saved";
export { listMixtapes } from "./mixtapes";
export { type NewsletterBody, subscribeNewsletter } from "./newsletter";
export { getRadioNowPlaying, getRandomRadioTrack } from "./radio";
export { searchTracks } from "./search";
export { listStories } from "./stories";
export { type SubmissionBody, submitTrack } from "./submissions";
export { getRandomTrack, getTrack, listTracks } from "./tracks";
export {
  EditionContentSchema,
  EditionDTOSchema,
  MixtapeDTOSchema,
  MixtapeSocialPostItemSchema,
  PublicUserSchema,
  RadioNowPlayingSchema,
  SocialPostItemSchema,
  SubmissionSchema,
  TrackListItemSchema,
  TrackSearchResultSchema,
} from "./_shared";

/**
 * The Fluncle API contract router. A flat map keyed by the canonical `verb_noun`
 * registry name — legible at a glance, and the key the coverage test (apps/web)
 * maps a route to. Grows one op per migrated route; the OpenAPI spec, the
 * validators, and the typed client all derive from this object, so they cannot
 * disagree with the handlers that implement it.
 *
 * Composed from the per-domain contract modules. Keep this merge the ONLY place
 * a domain joins the registry.
 */
export const contract = {
  ...adminBackfillsContract,
  ...adminEditionsContract,
  ...adminMixtapesContract,
  ...adminSocialContract,
  ...adminSubmissionsContract,
  ...adminTokensContract,
  ...adminTracksContract,
  ...devicesContract,
  ...editionsContract,
  ...healthContract,
  ...meContract,
  ...meGalaxyContract,
  ...meSavedContract,
  ...mixtapesContract,
  ...newsletterContract,
  ...radioContract,
  ...searchContract,
  ...storiesContract,
  ...submissionsContract,
  ...tracksContract,
};

export type FluncleContract = typeof contract;

/**
 * The set of canonical `verb_noun` operation names currently served by oRPC.
 * The coverage test (apps/web) reads this to assert every public API route is
 * either converted (named here) or on the explicit shrinking pending list.
 */
export const CONTRACT_OPERATION_NAMES = Object.keys(contract) as Array<keyof typeof contract>;
