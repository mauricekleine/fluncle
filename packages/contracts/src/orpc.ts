// The runtime oRPC contract registry — the contract-first source of truth the
// oRPC migration is built on (docs/orpc-migration-brief.md).
//
// `index.ts` is the package's PURE-TYPES surface (no runtime): the CLI, Raycast,
// and the browser extension import it and must never pull zod/@orpc into their
// bundles. This file is the *runtime* contract layer — `@orpc/contract` ops whose
// I/O are Zod schemas — and it lives on its own `./orpc` subpath so those
// pure-types consumers stay clean. From these contracts derive, in one place that
// cannot disagree: the request/response validators, the typed `Router` client,
// and the generated OpenAPI document.
//
// Naming follows the ratified Convention B (docs/naming-conventions.md): each op
// has a canonical `verb_noun` registry key whose camelCase projection is the
// OpenAPI `operationId` (`get_track` → `getTrack`). The REST path mirrors the
// live route; resources are plural, the op noun stays singular.
//
// Phase 1 (rails + proof) converts ONE public read — `get_track`. Every other
// route still falls through to TanStack; they join this registry one at a time in
// the fan-out phase, and the coverage test (apps/web) fails the build for any
// public route that has not.

import { oc } from "@orpc/contract";
import * as z from "zod";

// ── Shared schemas ───────────────────────────────────────────────────────────
// These mirror the pure-types DTOs in `./index.ts`. They are kept structurally
// in lock-step with those types; where a future op needs the full shape, derive
// the TS type from the schema (`z.infer`) rather than maintaining two copies.

/** Enrichment's track-level spectral summary (`TrackFeatures` in ./index.ts). */
const TrackFeaturesSchema = z
  .object({
    centroidHz: z.number().optional(),
    highRatio: z.number().optional(),
    midFlatness: z.number().optional(),
    onsetRate: z.number().optional(),
    subBassRatio: z.number().optional(),
  })
  .meta({ id: "TrackFeatures" });

/** A finding as the feed/log/admin board renders it (`TrackListItem` in ./index.ts). */
export const TrackListItemSchema = z
  .object({
    addedAt: z.string(),
    addedToSpotify: z.boolean(),
    album: z.string().optional(),
    albumImageUrl: z.string().optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    discogsReleaseUrl: z.string().optional(),
    durationMs: z.number(),
    enrichmentStatus: z.string(),
    features: TrackFeaturesSchema.optional(),
    galaxy: z
      .object({
        key: z.enum(["astral", "lunar", "nebular", "solar"]),
        name: z.string(),
      })
      .optional(),
    isrc: z.string().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    logId: z.string().optional(),
    logPageUrl: z.string().optional(),
    note: z.string().optional(),
    observationAudioUrl: z.string().optional(),
    observationDurationMs: z.number().optional(),
    observationGeneratedAt: z.string().optional(),
    popularity: z.number().optional(),
    postedToTelegram: z.boolean(),
    previewUrl: z.string().optional(),
    releaseDate: z.string().optional(),
    spotifyUrl: z.string(),
    tiktokUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    type: z.literal("finding").optional(),
    updatedAt: z.string().optional(),
    vibeX: z.number().optional(),
    vibeY: z.number().optional(),
    videoModel: z.string().optional(),
    videoModelReasoning: z.string().optional(),
    videoSquaredAt: z.string().optional(),
    videoUrl: z.string().optional(),
    videoVehicle: z.string().optional(),
    youtubeUrl: z.string().optional(),
  })
  .meta({ id: "TrackListItem" });

/** A per-platform distribution row (`MixtapeSocialPostItem`-adjacent; see ./index.ts). */
const MixtapeMemberSchema = TrackListItemSchema.extend({
  startMs: z.number().optional(),
}).meta({ id: "MixtapeMember" });

/** A mixtape as `/mixtapes` + `/api/mixtapes` emit it (`MixtapeDTO` in ./index.ts). */
export const MixtapeDTOSchema = z
  .object({
    addedAt: z.string().optional(),
    artists: z.tuple([z.literal("Fluncle")]),
    coverImageUrl: z.string().optional(),
    createdAt: z.string().optional(),
    durationMs: z.number().optional(),
    externalUrls: z.object({
      mixcloud: z.string().optional(),
      soundcloud: z.string().optional(),
      youtube: z.string().optional(),
    }),
    id: z.string().optional(),
    logId: z.string().optional(),
    memberCount: z.number(),
    members: z.array(MixtapeMemberSchema),
    note: z.string().optional(),
    plannedFor: z.string().optional(),
    publishedAt: z.string().optional(),
    recordedAt: z.string().optional(),
    sequenceNumber: z.number().optional(),
    status: z.enum(["distributing", "draft", "published"]),
    title: z.string(),
    type: z.literal("mixtape"),
    updatedAt: z.string().optional(),
  })
  .meta({ id: "MixtapeDTO" });

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * `get_track` → `GET /tracks/{idOrLogId}` (operationId `getTrack`).
 *
 * Public read of a single finding by its Spotify trackId OR its Log ID — the
 * lookup the enrichment agent uses to turn its input into track metadata. A Log
 * ID can also resolve to a mixtape, so the response is the discriminated
 * `{ ok: true } & ({ track } | { mixtape })` envelope (mirrors `TrackGetResponse`
 * in ./index.ts, plus the mixtape arm the live route already serves).
 */
export const getTrack = oc
  .route({
    method: "GET",
    operationId: "getTrack",
    path: "/tracks/{idOrLogId}",
    summary: "Get a finding (or mixtape) by Spotify trackId or Log ID",
    tags: ["Tracks"],
  })
  .input(z.object({ idOrLogId: z.string() }))
  .output(
    z.union([
      z.object({ ok: z.literal(true), track: TrackListItemSchema }),
      z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true) }),
    ]),
  );

/**
 * The Fluncle API contract router. Grows one operation per migrated route; the
 * OpenAPI spec, the validators, and the typed client all derive from this object,
 * so they cannot disagree with the handlers that implement it.
 *
 * Keyed by the canonical `verb_noun` registry name so the registry is legible at
 * a glance and the coverage test can map a route to its contract by that name.
 */
export const contract = {
  get_track: getTrack,
};

export type FluncleContract = typeof contract;

/**
 * The set of canonical `verb_noun` operation names currently served by oRPC.
 * The coverage test (apps/web) reads this to assert every public API route is
 * either converted (named here) or on the explicit shrinking pending list.
 */
export const CONTRACT_OPERATION_NAMES = Object.keys(contract) as Array<keyof typeof contract>;
