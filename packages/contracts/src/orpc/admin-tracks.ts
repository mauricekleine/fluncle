// The `admin-tracks` domain contract module — the admin-gated track ops (the
// enrichment/curation write path + the video control-plane). This is the ADMIN
// wave's pattern-complete pilot (docs/orpc-migration-brief.md, the admin
// section): it exercises every admin pattern the fan-out will reuse —
//
//   - the FIELD-LEVEL role guard: `update_track` is on `adminProcedure` (both the
//     operator and the agent authenticate), and the handler reads `context.role`
//     to bound the agent to analysis fields (an operator-only field written by the
//     agent is a 403, not a silent drop);
//   - an `operatorProcedure` mint: `observe_track` (the live route is
//     `requireOperator`, so it stays operator-only — see the server module);
//   - the JSON video CONTROL-PLANE: `presign_track_video_uploads` +
//     `finalize_track_video` — the bytes go direct to R2 via the presigned URL, so
//     the bodies oRPC sees are plain JSON (in scope per the brief).
//
// Inputs are LOOSE/passthrough by design: the live admin routes do NOT
// schema-validate — they narrow `unknown` in-handler and emit their own codes
// (`invalid_request`/`note_too_long`/`no_fields`/…). A permissive contract keeps
// oRPC from pre-rejecting so that logic — and its exact codes — stays
// byte-for-byte for the admin consumers (the `fluncle admin` CLI + the enrichment
// agent). A future admin wave adds an op here and one import line in `./index.ts`,
// touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { FeedItemSchema, TrackListItemSchema } from "./_shared";

/**
 * The PATCH /admin/tracks/{trackId} body — the generic admin track update. LOOSE
 * + optional UNKNOWN: the live route narrows each field itself (number/string
 * guards, the `enrichmentStatus` enum, `parseEditorialNote`) and runs the
 * agent-role field guard, so the contract must not pre-reject. The handler reads
 * the raw input and reproduces that logic verbatim.
 */
const UpdateTrackBodySchema = z.looseObject({
  bpm: z.unknown().optional(),
  enrichmentStatus: z.unknown().optional(),
  features: z.unknown().optional(),
  isrc: z.unknown().optional(),
  key: z.unknown().optional(),
  logId: z.unknown().optional(),
  note: z.unknown().optional(),
  vibeX: z.unknown().optional(),
  vibeY: z.unknown().optional(),
  videoUrl: z.unknown().optional(),
});

/**
 * The observe body (POST /admin/tracks/{trackId}/observe). LOOSE: the live route
 * resolves the model/voice/duration defaults and voice-GATES the script itself
 * (emitting `no_script`/`voice_gate`), so the contract stays permissive to keep
 * those codes byte-for-byte.
 */
const ObserveTrackBodySchema = z.looseObject({
  contextNote: z.unknown().optional(),
  durationMs: z.unknown().optional(),
  durationTargetSec: z.unknown().optional(),
  model: z.unknown().optional(),
  script: z.unknown().optional(),
  voiceId: z.unknown().optional(),
  voiceSettings: z.unknown().optional(),
});

/**
 * The context body (POST /admin/tracks/{trackId}/context). LOOSE: an agent-supplied
 * `query` override for the Firecrawl search, and `refresh` — re-run the fetch+distil
 * even when a note already exists (the default short-circuits on `skipped:true`).
 * The handler narrows both in-handler, so the contract stays permissive.
 */
const ContextTrackBodySchema = z.looseObject({
  query: z.unknown().optional(),
  refresh: z.unknown().optional(),
});

/**
 * The note body (POST /admin/tracks/{trackId}/note). LOOSE: the live handler
 * voice-GATES the authored `note` itself (emitting `no_note`/`note_too_short`/
 * `note_too_long`/`voice_gate`) and enforces the fill-empty-only guard, so the
 * contract stays permissive to keep those codes byte-for-byte.
 */
const NoteTrackBodySchema = z.looseObject({
  note: z.unknown().optional(),
});

/**
 * The presign body (POST /admin/tracks/{trackId}/video/uploads). LOOSE: the live
 * route validates `fields` itself (`no_fields`/`bad_field`/`unknown_field`/
 * `no_footage`), so the contract stays permissive.
 */
const PresignVideoUploadsBodySchema = z.looseObject({
  fields: z.unknown().optional(),
});

/**
 * The finalize body (POST /admin/tracks/{trackId}/video/finalize). LOOSE: every
 * field is optional + normalized in-handler (trim/slice, the `squared` flag, the
 * model/reasoning defaults), so the contract stays permissive.
 */
const FinalizeVideoBodySchema = z.looseObject({
  squared: z.unknown().optional(),
  videoGrain: z.unknown().optional(),
  videoModel: z.unknown().optional(),
  videoModelReasoning: z.unknown().optional(),
  videoVehicle: z.unknown().optional(),
});

/** A presigned-upload row as `presign_track_video_uploads` returns it. */
const VideoUploadSchema = z
  .object({
    contentType: z.string(),
    field: z.string(),
    key: z.string(),
    url: z.string(),
  })
  .meta({ id: "VideoUpload" });

/**
 * `update_track` → `PATCH /admin/tracks/{trackId}` (operationId `updateTrack`).
 *
 * The generic admin track update (BPM/key/features/status/video/note/vibe/identity
 * backfill). On `adminProcedure` — BOTH the operator and the agent authenticate;
 * the FIELD-LEVEL role guard runs in-handler (the agent may write only analysis
 * fields; an operator-only field → 403 `forbidden`). Reuses `updateTrack`,
 * preserving the `{ ok: true, fields, trackId }` envelope and the live
 * `note_too_long`/422, `not_found`/404 codes.
 */
export const updateTrack = oc
  .route({
    method: "PATCH",
    operationId: "updateTrack",
    path: "/admin/tracks/{trackId}",
    summary: "Update a track's enrichment/curation fields (role-gated per field)",
    tags: ["Admin"],
  })
  .input(UpdateTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      fields: z.array(z.string()),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

/**
 * `observe_track` → `POST /admin/tracks/{trackId}/observe` (operationId
 * `observeTrack`).
 *
 * Mint the audio-observation artifact: author-time the agent has already written
 * the recovered-audio script, so this step VOICE-GATES it, renders it (ElevenLabs),
 * uploads the artifact to R2, and writes back. It no longer holds Firecrawl — it
 * reads the already-stored `context_note` (written by `context_track`) as its
 * fuel. On `adminProcedure` (agent-allowed): flipped from the operator tier so the
 * Hermes cron can drive it (docs/hermes-automation-brief.md Build order #3). Idempotent
 * per finding — an existing `observation_audio_url` is a no-op (`skipped: true`),
 * so re-pulling an in-flight item is safe (`observe:${logId}`). Preserves the
 * `{ ok: true, audioUrl, durationMs, … }` envelope and the `no_script`/400,
 * `voice_gate`/422, `no_log_id`/400 codes.
 */
export const observeTrack = oc
  .route({
    method: "POST",
    operationId: "observeTrack",
    path: "/admin/tracks/{trackId}/observe",
    summary: "Mint a track's spoken audio-observation artifact",
    tags: ["Admin"],
  })
  .input(ObserveTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      audioUrl: z.string(),
      durationMs: z.number(),
      generatedAt: z.string(),
      jsonUrl: z.string(),
      logId: z.string(),
      ok: z.literal(true),
      // `true` when an observation already existed and the call was a no-op
      // (idempotent re-pull); absent on a fresh mint.
      skipped: z.boolean().optional(),
      textUrl: z.string(),
      trackId: z.string(),
      voiceId: z.string(),
    }),
  );

/**
 * `context_track` → `POST /admin/tracks/{trackId}/context` (operationId
 * `contextTrack`).
 *
 * Fetch the track's FACTUAL context (Firecrawl: label/year/release) and write it
 * to the internal `context_note` column ONLY — no script authoring, no render.
 * This is the split-out context half of the observation pipeline
 * (docs/hermes-automation-brief.md Build order #3): `context_track` fills the
 * note so `observe_track` can author + render from it without holding Firecrawl.
 * The action segment is the single word `context` (Convention B §6: no dash-compound
 * action segments — the dash-compound `observe-context` is retired with no alias).
 *
 * On `adminProcedure` (agent-allowed). Writes `context_note` QUIETLY — it touches
 * only that internal column, so it does NOT bump `updated_at` (no public surface
 * moves; the feed/lastmod/enrich-sweep stale clock are undisturbed). Idempotent
 * per finding — an existing `context_note` is a no-op (`skipped: true`), keyed
 * `context:${logId}`, so an external cron can fire safely. The Firecrawl output is
 * UNTRUSTED web content treated strictly as DATA (stored as fuel, never executed).
 * Codes: `not_found`/404, `no_log_id`/400.
 */
export const contextTrack = oc
  .route({
    method: "POST",
    operationId: "contextTrack",
    path: "/admin/tracks/{trackId}/context",
    summary: "Fetch + store a track's factual context note (Firecrawl facts only)",
    tags: ["Admin"],
  })
  .input(ContextTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      contextNote: z.string(),
      logId: z.string(),
      ok: z.literal(true),
      // `true` when a context note already existed and the call was a no-op
      // (idempotent re-pull); absent on a fresh fetch. `--refresh` forces a re-fetch,
      // so it never short-circuits and `skipped` stays absent.
      skipped: z.boolean().optional(),
      sources: z.array(z.string()),
      trackId: z.string(),
    }),
  );

/**
 * `note_track` → `POST /admin/tracks/{trackId}/note` (operationId `noteTrack`).
 *
 * AUTO-author a finding's editorial `note` (the written-note sibling of
 * `observe_track`): the agent has already authored the note in Fluncle's voice from
 * the `context_note` fuel + track metadata; this step VOICE-GATES it (the written
 * register's banned-word / earthly-geography / exclamation / "we"-as-company scan,
 * shared with the spoken gate) and stores it into the `note` field. On
 * `adminProcedure` (agent-allowed) so the on-box note cron can drive it — `observe`
 * is the precedent for the tier (docs/agents/note-agent.md).
 *
 * SAFETY (the cardinal guarantee): it fills an EMPTY note ONLY. A finding that
 * already carries a note — operator-written OR previously auto-authored — is a no-op
 * (`skipped: true`); the agent NEVER clobbers an existing note. The operator override
 * always wins, enforced server-side. Every authoring attempt stamps the
 * `backfill_note_*` "ran" state (board done-when-ran semantics); a fill also stamps
 * `backfill_note_done_at`. Codes: `not_found`/404, `no_log_id`/400, `no_note`/400,
 * `note_too_short`/422, `note_too_long`/422, `voice_gate`/422.
 */
export const noteTrack = oc
  .route({
    method: "POST",
    operationId: "noteTrack",
    path: "/admin/tracks/{trackId}/note",
    summary: "Auto-author a finding's editorial note (fills an empty note only)",
    tags: ["Admin"],
  })
  .input(NoteTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      note: z.string(),
      ok: z.literal(true),
      // `true` when a note already existed and the call was a no-op (the
      // fill-empty-only guard refused to clobber it); absent on a fresh fill.
      skipped: z.boolean().optional(),
      trackId: z.string(),
    }),
  );

/**
 * `presign_track_video_uploads` → `POST /admin/tracks/{trackId}/video/uploads`
 * (operationId `presignTrackVideoUploads`).
 *
 * Phase 1 of the presigned direct-to-R2 upload flow — the JSON control-plane: the
 * caller lists the artifact `fields`, the Worker signs one PUT URL per field
 * (bytes go straight to R2, bypassing the edge body limit). On `operatorProcedure`
 * (live `requireOperator`). Preserves the `{ ok: true, logId, trackId, uploads }`
 * envelope and the `no_fields`/`bad_field`/`unknown_field`/`no_footage` 400 codes.
 */
export const presignTrackVideoUploads = oc
  .route({
    method: "POST",
    operationId: "presignTrackVideoUploads",
    path: "/admin/tracks/{trackId}/video/uploads",
    summary: "Presign direct-to-R2 PUT URLs for a track's video artifacts",
    tags: ["Admin"],
  })
  .input(PresignVideoUploadsBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      uploads: z.array(VideoUploadSchema),
    }),
  );

/**
 * `finalize_track_video` → `POST /admin/tracks/{trackId}/video/finalize`
 * (operationId `finalizeTrackVideo`).
 *
 * Phase 2 of the presigned flow — links the canonical web cut (sets video_url to
 * <log-id>/footage.mp4 and stores the vehicle / model ledger; `squared` stamps the
 * two-master layout). On `operatorProcedure` (live `requireOperator`). Preserves
 * the `{ ok: true, logId, trackId, videoUrl }` envelope and the `not_found`/404,
 * `no_log_id`/400 codes.
 */
export const finalizeTrackVideo = oc
  .route({
    method: "POST",
    operationId: "finalizeTrackVideo",
    path: "/admin/tracks/{trackId}/video/finalize",
    summary: "Finalize a track's uploaded video bundle (link the canonical cut)",
    tags: ["Admin"],
  })
  .input(FinalizeVideoBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      videoUrl: z.string(),
    }),
  );

/**
 * `requeue_video` → `POST /admin/tracks/{trackId}/video/requeue` (operationId
 * `requeueVideo`).
 *
 * Clear a finding's video state so it RE-ENTERS the render queue AND drops cleanly
 * off radio until re-rendered (the render skill improved → re-film an already-filmed
 * finding). It clears BOTH display/queue gates: `video_url` (the render queue gates
 * on it — `hasVideo=false` is `video_url is null`) and `video_squared_at` (radio
 * eligibility gates on it). Clearing only `video_url` would re-queue the finding but
 * leave it eligible-but-broken on radio (radio plays the square master, keyed on
 * `video_squared_at`, with no playable source). The video LEDGER columns
 * (`video_vehicle`/`video_grain`/`video_model`/`video_model_reasoning`) are
 * deliberately LEFT INTACT — they describe the prior render and are read by the next
 * video agent to DIVERSIFY away from recent choices, so they help the re-render.
 *
 * OPERATOR tier (live `requireOperator`): this removes a LIVE published video, so it
 * must NOT be agent-tier — the box agent never clears videos. Idempotent: clearing an
 * already-clear finding is a clean no-op (NULL→NULL). Codes: `not_found`/404,
 * `no_log_id`/400. The body is empty (the trackId path param is the whole input).
 *
 * CACHE CAVEAT (known follow-up, NOT built here): re-shipping `footage.mp4` to the
 * SAME R2 key leaves Cloudflare Media-Transformation renditions cached separately
 * (the web player streams MT crops, not the master), so a re-render may need a cache
 * purge of the transform URLs. See docs/video-variants.md + the r2-purge note.
 */
export const requeueVideo = oc
  .route({
    method: "POST",
    operationId: "requeueVideo",
    path: "/admin/tracks/{trackId}/video/requeue",
    summary: "Clear a finding's video so it re-enters the render queue (and off radio)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(
    z.object({
      // `true` when the finding already had no video and the call was a no-op
      // (idempotent re-requeue); absent when a live video was actually cleared.
      alreadyClear: z.boolean().optional(),
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

/**
 * The publish-track result (`PublishTrackResult` in ../index.ts). The
 * `POST /admin/tracks` body — `publishTrack`'s output envelope.
 */
const PublishTrackResultSchema = z
  .object({
    addedToSpotify: z.boolean(),
    dryRun: z.boolean(),
    message: z.string(),
    postedToTelegram: z.boolean(),
    track: z.object({
      album: z.string().optional(),
      albumImageUrl: z.string().optional(),
      artists: z.array(z.string()),
      durationMs: z.number(),
      isrc: z.string().optional(),
      label: z.string().optional(),
      logId: z.string().optional(),
      logPageUrl: z.string().optional(),
      popularity: z.number().optional(),
      previewUrl: z.string().optional(),
      spotifyUrl: z.string(),
      title: z.string(),
      trackId: z.string(),
    }),
  })
  .meta({ id: "PublishTrackResult" });

/**
 * `list_tracks_admin` → `GET /admin/tracks` (operationId `listTracksAdmin`).
 *
 * The admin board's archive query (live `requireAdmin` — a read, agent-allowed).
 * Two shapes off one route, both preserved byte-for-byte:
 *   - the `?q=` free-text SEARCH branch returns a flat `{ tracks }` (no
 *     cursor/totalCount envelope);
 *   - otherwise the paginated LIST page (the `FeedListPage`/`TrackListPage` body
 *     itself, no `ok` envelope), filtered by `order`/`hasVideo`/`status`.
 * Every query param is a tolerant optional string — the live route parses + clamps
 * in-handler and never 400s — so the contract stays permissive. The output is the
 * union of the two live bodies.
 */
export const listTracksAdmin = oc
  .route({
    method: "GET",
    operationId: "listTracksAdmin",
    path: "/admin/tracks",
    summary: "Query the admin archive board (search or paginated list)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      // `hasContext` / `hasObservation` / `hasNote` power the three agent queues (the
      // context queue = `hasContext=false`; the observation queue = `hasContext=true`
      // AND `hasObservation=false`; the auto-note queue = `hasContext=true` AND
      // `hasNote=false`). Tri-state tolerant strings ("true"/"false"), parsed +
      // clamped in-handler exactly like `hasVideo`.
      hasContext: z.string().optional(),
      hasNote: z.string().optional(),
      hasObservation: z.string().optional(),
      hasVideo: z.string().optional(),
      limit: z.string().optional(),
      order: z.string().optional(),
      q: z.string().optional(),
      // `--retry-empty`: widen the `hasContext=false` context queue to also re-pick
      // CONFIRMED-EMPTY finds (`context_status = 'empty'`). Tri-state tolerant string,
      // parsed in-handler like the other booleans; only honoured with `hasContext=false`.
      retryEmptyContext: z.string().optional(),
      status: z.string().optional(),
    }),
  )
  .output(
    // The LIST page arm is FIRST: it carries the required `totalCount`, so a list
    // response matches it (and keeps `nextCursor`/`totalCount`). The SEARCH arm is
    // a strict subset (`{ tracks }` only); if it were first, Zod's union would
    // match a list page against it and strip the cursor/count. A search response
    // (no `totalCount`) falls through to the second arm.
    z.union([
      z.object({
        nextCursor: z.string().optional(),
        totalCount: z.number(),
        tracks: z.array(FeedItemSchema),
      }),
      z.object({ tracks: z.array(TrackListItemSchema) }),
    ]),
  );

/**
 * `publish_track` → `POST /admin/tracks` (operationId `publishTrack`).
 *
 * Publish a finding from a Spotify URL: certify it, post to Telegram, kick off
 * async enrichment. Operator tier (live `requireOperator`). LOOSE body — the live
 * route validates `spotifyUrl` itself (`invalid_request`/400) and caps the note
 * (`note_too_long`). Preserves the `{ ok: true, ...PublishTrackResult }` envelope.
 */
export const publishTrack = oc
  .route({
    method: "POST",
    operationId: "publishTrack",
    path: "/admin/tracks",
    summary: "Publish a finding from a Spotify URL",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      dryRun: z.unknown().optional(),
      note: z.unknown().optional(),
      spotifyUrl: z.unknown().optional(),
    }),
  )
  .output(PublishTrackResultSchema.extend({ ok: z.literal(true) }));

/** The `admin-tracks` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTracksContract = {
  context_track: contextTrack,
  finalize_track_video: finalizeTrackVideo,
  list_tracks_admin: listTracksAdmin,
  note_track: noteTrack,
  observe_track: observeTrack,
  presign_track_video_uploads: presignTrackVideoUploads,
  publish_track: publishTrack,
  requeue_video: requeueVideo,
  update_track: updateTrack,
};
