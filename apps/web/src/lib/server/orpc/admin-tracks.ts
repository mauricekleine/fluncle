// The `admin-tracks` domain router module — the admin wave's pilot (every admin
// pattern the fan-out reuses). Each handler reuses the live `/api/admin/tracks/*`
// route logic verbatim; the auth tier moves from the per-handler `requireAdmin` /
// `requireOperator` to the oRPC procedure middleware (../orpc-auth), and the
// field-level role check reads `context.role` in-handler.
//
//   - `update_track` — port of PATCH /admin/tracks/{trackId}. On `adminAuth` (the
//     live `requireAdmin`: operator OR agent). The FIELD-LEVEL guard reads
//     `context.role`: the agent may write ONLY analysis fields; an operator-only
//     field written by the agent is a 403 `forbidden` (rejected, not dropped). The
//     operator may write anything.
//   - `observe_track` — POST /admin/tracks/{trackId}/observe. FLIPPED to the
//     agent tier (`adminAuth` only) so the Hermes observation cron can drive it
//     (docs/hermes-automation-brief.md Build order #3). Idempotent per finding (an
//     existing observation is a no-op). It no longer holds Firecrawl — it reads the
//     stored `context_note` (written by `context_track`) as fuel; the voice gate
//     still hard-fails any banned-identity-word / earthly-geography violation.
//   - `context_track` — POST /admin/tracks/{trackId}/context. The split-out
//     context half (agent tier): fetch the Firecrawl FACTS and write `context_note`
//     ONLY, quietly (no updated_at bump). Idempotent per finding. Firecrawl output
//     is untrusted web content treated strictly as DATA.
//   - `presign_track_video_uploads` / `finalize_track_video` — ports of the JSON
//     video control-plane (`…/video/uploads`, `…/video/finalize`). Both live routes
//     are `requireOperator`, so both are on the operator tier.

import { env } from "cloudflare:workers";
import { type InferContractRouterInputs } from "@orpc/contract";
import { ORPCError } from "@orpc/server";
import { type contract } from "@fluncle/contracts/orpc";
import { FOUND_BASE, trackMedia } from "../../media";
import { parseEditorialNote } from "../http-errors";
import { publishTrack } from "../publish";
import {
  DEFAULT_OBSERVATION_MODEL,
  DEFAULT_VOICE_SETTINGS,
  type ObservationArtifact,
  type ObservationModel,
  type ObservationVoiceSettings,
  buildContextQuery,
  fetchTrackContext,
  gateObservationScript,
  renderObservation,
  resolveVoiceId,
} from "../observation";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { VIDEOS_BUCKET, presignUploads } from "../r2-presign";
import { type TrackUpdate, updateTrack } from "../track-update";
import {
  type EnrichmentStatusFilter,
  ENRICHMENT_STATUS_FILTERS,
  decodeTrackCursor,
  getTrackByIdOrLogId,
  getTrackContextNote,
  listTracks,
  searchTracks,
} from "../tracks";
import { type VideoArtifact, artifactByField } from "../video-bundle";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Fields only the operator may write: editorial voice (note), the vehicle/video
// (videoUrl), the map placement (vibeX/vibeY), and the immutable identity fields
// (isrc/logId). The agent role is limited to machine-measured analysis (bpm, key,
// features, enrichmentStatus) — overwritable, internal, no public footprint.
// Ported verbatim from the live PATCH route.
const OPERATOR_ONLY_FIELDS: (keyof TrackUpdate)[] = [
  "isrc",
  "logId",
  "note",
  "vibeX",
  "vibeY",
  "videoUrl",
];

// The handler input shapes come straight from the contract (the single source of
// truth): `InferContractRouterInputs<typeof contract>` projects each op's Zod
// `.input(...)` to its TS type, so a `PatchBody`/`ObserveBody` hand-mirror can't
// drift from the schema the route validates. The contract inputs are LOOSE (each
// field `?: unknown`) by design — the handler narrows them itself — so these are
// `{ …?: unknown; trackId: string }`, exactly what the old hand-types said.
type AdminTrackInputs = InferContractRouterInputs<typeof contract>;
type PatchBody = AdminTrackInputs["update_track"];
type ObserveBody = AdminTrackInputs["observe_track"];

function resolveModel(value: unknown): ObservationModel {
  return value === "eleven_v3" || value === "eleven_multilingual_v2"
    ? value
    : DEFAULT_OBSERVATION_MODEL;
}

function resolveVoiceSettings(value: unknown): ObservationVoiceSettings {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_VOICE_SETTINGS;
  }

  const raw = value as Record<string, unknown>;
  const num = (key: keyof ObservationVoiceSettings, fallback: number): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback;

  return {
    similarityBoost: num("similarityBoost", DEFAULT_VOICE_SETTINGS.similarityBoost),
    speed: num("speed", DEFAULT_VOICE_SETTINGS.speed),
    stability: num("stability", DEFAULT_VOICE_SETTINGS.stability),
    style: num("style", DEFAULT_VOICE_SETTINGS.style),
  };
}

// Admin board list page-size bounds, ported verbatim from the live GET route.
const ADMIN_LIST_DEFAULT_LIMIT = 16;
const ADMIN_LIST_MAX_LIMIT = 48;

// Tri-state boolean query params ("true"/"false"/absent → true/false/undefined),
// ported verbatim from the live `hasVideo` route. `hasContext`/`hasObservation`
// reuse it to drive the two observation queues.
function parseTriStateBool(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseEnrichmentStatus(value: string | undefined): EnrichmentStatusFilter | undefined {
  return value && (ENRICHMENT_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as EnrichmentStatusFilter)
    : undefined;
}

function parseAdminLimit(value: string | undefined): number {
  return parseLimit(value, ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT);
}

function resolveDurationTargetSec(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 90) {
    return Math.round(value);
  }

  return 30;
}

// The canonical fault wrapper for these handlers: an ORPCError (a guard the
// procedure or the field check threw) passes through untouched; anything else
// (an ApiError from a reused helper — note_too_long, voice_gate, not_found,
// no_log_id — or an unexpected throw) becomes a wire-compatible fault via
// `apiFault`, so the rails encoder reproduces the legacy `{ code, message }` body.
function toFault(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error;
  }

  return apiFault(error);
}

/**
 * Build the `admin-tracks` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminTracksHandlers(os: Implementer) {
  // PATCH /admin/tracks/{trackId} — on `adminAuth` (operator OR agent). The
  // field-level guard reads `context.role`.
  const updateTrackHandler = os.update_track.use(adminAuth).handler(async ({ context, input }) => {
    try {
      const body: PatchBody = input;
      const trackId = body.trackId;
      const update: TrackUpdate = {};

      if (typeof body.bpm === "number" && Number.isFinite(body.bpm)) {
        update.bpm = body.bpm;
      }

      if (typeof body.key === "string") {
        update.key = body.key;
      }

      if (typeof body.features === "string") {
        update.features = body.features;
      }

      if (typeof body.videoUrl === "string") {
        update.videoUrl = body.videoUrl;
      }

      if (
        body.enrichmentStatus === "pending" ||
        body.enrichmentStatus === "done" ||
        body.enrichmentStatus === "failed"
      ) {
        update.enrichmentStatus = body.enrichmentStatus;
      }

      // A present note sets it (including "" which clears the stored note); an
      // absent note leaves it untouched. parseEditorialNote throws on too-long.
      if (typeof body.note === "string") {
        update.note = parseEditorialNote(body.note);
      }

      if (typeof body.vibeX === "number" && Number.isFinite(body.vibeX)) {
        update.vibeX = body.vibeX;
      }

      if (typeof body.vibeY === "number" && Number.isFinite(body.vibeY)) {
        update.vibeY = body.vibeY;
      }

      // Straggler repair: one-time backfill of identity fields into null slots
      // (updateTrack enforces immutability once set).
      if (typeof body.isrc === "string") {
        update.isrc = body.isrc;
      }

      if (typeof body.logId === "string") {
        update.logId = body.logId;
      }

      // The agent role may only touch analysis fields. Reject (not silently drop)
      // an attempt at an operator-only field — a 403 the gate can voice. The role
      // is read from the oRPC context (lifted by `adminAuth`), not re-derived.
      if (context.role === "agent") {
        const blocked = OPERATOR_ONLY_FIELDS.filter((field) => field in update);

        if (blocked.length > 0) {
          throw new ORPCError("FORBIDDEN", {
            data: {
              apiCode: "forbidden",
              apiMessage: `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
            },
            message: `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
            status: 403,
          });
        }
      }

      const result = await updateTrack(trackId, update);

      return { ok: true as const, ...result };
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/tracks — admin tier (live `requireAdmin`). The admin board query:
  // a `?q=` free-text search (flat `{ tracks }`) OR the paginated list page (the
  // page body itself, filtered by order/hasVideo/status). Both shapes preserved.
  const listTracksAdminHandler = os.list_tracks_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const q = input.q?.trim();

      if (q) {
        return {
          tracks: await searchTracks({
            limit: parseAdminLimit(input.limit),
            q,
          }),
        };
      }

      return await listTracks({
        cursor: decodeTrackCursor(input.cursor ?? null),
        hasContext: parseTriStateBool(input.hasContext),
        hasObservation: parseTriStateBool(input.hasObservation),
        hasVideo: parseTriStateBool(input.hasVideo),
        limit: parseAdminLimit(input.limit),
        order: input.order === "asc" ? "asc" : "desc",
        status: parseEnrichmentStatus(input.status),
      });
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks — operator tier (live `requireOperator`). Add (publish) a
  // finding from a Spotify URL, then kick off async enrichment.
  const addTrackHandler = os.add_track
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const body: AdminTrackInputs["add_track"] = input;

        if (typeof body.spotifyUrl !== "string") {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "invalid_request", apiMessage: "Missing Spotify track URL" },
            message: "Missing Spotify track URL",
            status: 400,
          });
        }

        // The note rides into the Telegram post AND the stored editorial note, so
        // cap it on the add path too. On add, an empty note means "no note".
        const note = parseEditorialNote(body.note);

        const result = await publishTrack(body.spotifyUrl, {
          dryRun: body.dryRun === true,
          note: note || undefined,
        });

        // No on-add enrichment push: the add leaves the track at the schema
        // default `enrichment_status = "pending"`, which is queue-eligible. The
        // on-box `fluncle-enrich` `--no-agent` cron drains the enrich-queue every
        // ~5 min, analyzes on-box (ffmpeg + bun), and writes back via
        // `fluncle admin tracks update`. See docs/track-lifecycle.md (Phase 2).

        return { ok: true as const, ...result };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/observe — agent tier (`adminAuth` only). FLIPPED
  // from the operator tier so the Hermes observation cron drives it
  // (docs/hermes-automation-brief.md Build order #3).
  const observeTrackHandler = os.observe_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: ObserveBody = input;
      const idOrLogId = body.trackId;
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
          message: `No track with id ${idOrLogId}`,
          status: 404,
        });
      }

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      // Idempotency (`observe:${logId}`): a finding that already has an observation
      // is a no-op, so re-pulling an in-flight item — or an external cron firing on
      // a fixed interval — never spends a second ElevenLabs render or overwrites the
      // existing artifact. The versioned playback URL on the row is already keyed by
      // the prior render; report it back unchanged.
      if (track.observationAudioUrl) {
        const existingBase = encodeURIComponent(track.logId);

        return {
          audioUrl: track.observationAudioUrl,
          durationMs: track.observationDurationMs ?? 0,
          generatedAt: track.observationGeneratedAt ?? "",
          jsonUrl: `${FOUND_BASE}/${existingBase}/observation.json`,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          textUrl: trackMedia(track.logId).observationTextUrl,
          trackId: track.trackId,
          voiceId: "",
        };
      }

      // The agent authors + voice-gates the script; the Worker re-runs the
      // mechanical scan (defence in depth) and hard-fails on any violation.
      const script = gateObservationScript(body.script);
      const model = resolveModel(body.model);
      const voiceSettings = resolveVoiceSettings(body.voiceSettings);
      const durationTargetSec = resolveDurationTargetSec(body.durationTargetSec);
      const voiceId = await resolveVoiceId(
        typeof body.voiceId === "string" ? body.voiceId : undefined,
      );

      // The factual context, treated strictly as INTERNAL DATA (never instructions).
      // observe_track no longer holds Firecrawl: it reads the already-stored
      // `context_note` (written by the split-out `context_track` step). Order of
      // preference: an explicit body.contextNote (the agent passing the fuel it
      // authored from), then the stored note, then — only if neither exists — a
      // best-effort Firecrawl fetch so a finding that skipped context_track still
      // resolves. The note is persisted only if it was freshly fetched here.
      const storedContextNote = await getTrackContextNote(track.trackId);
      let contextNote = "";
      let freshlyFetched = false;

      if (typeof body.contextNote === "string" && body.contextNote.trim()) {
        contextNote = body.contextNote.trim().slice(0, 2000);
      } else if (storedContextNote?.trim()) {
        contextNote = storedContextNote.trim().slice(0, 2000);
      } else {
        const fetched = await fetchTrackContext(buildContextQuery(track));
        contextNote = fetched.contextNote;
        freshlyFetched = Boolean(fetched.contextNote);
      }

      // Render the spoken observation (ElevenLabs).
      const { bytes } = await renderObservation(voiceId, { model, text: script, voiceSettings });

      // Duration: ElevenLabs doesn't return one and the Worker can't probe (no
      // ffprobe). The agent passes the ffprobe value; absent it, estimate from the
      // target with a noted ±budget. The radio page never re-probes.
      const durationMs =
        typeof body.durationMs === "number" &&
        Number.isFinite(body.durationMs) &&
        body.durationMs > 0
          ? Math.round(body.durationMs)
          : durationTargetSec * 1000;

      const media = trackMedia(track.logId);
      const generatedAt = new Date().toISOString();

      const artifact: ObservationArtifact = {
        audioUrl: media.observationAudioUrl,
        ...(contextNote ? { contextNote } : {}),
        durationMs,
        durationTargetSec,
        generatedAt,
        logId: track.logId,
        model,
        provider: "elevenlabs",
        text: script,
        textUrl: media.observationTextUrl,
        trackId: track.trackId,
        voiceId,
        voiceSettings,
      };

      // Upload the three R2 objects at <log-id>/<name> (the Worker holds the
      // ≈0.5 MB bytes — direct put, no presign needed for a small artifact).
      const base = encodeURIComponent(track.logId);
      // Independent objects, distinct keys — write them together, then flag the DB.
      await Promise.all([
        env.VIDEOS.put(`${track.logId}/observation.mp3`, bytes, {
          httpMetadata: { contentType: "audio/mpeg" },
        }),
        env.VIDEOS.put(`${track.logId}/observation.txt`, script, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        }),
        env.VIDEOS.put(`${track.logId}/observation.json`, JSON.stringify(artifact, null, 2), {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        }),
      ]);

      // Persist: the audio url (the "has observation" flag) + duration + timestamp
      // (visible — they bump lastmod). Backfill the context note only when this step
      // freshly fetched it (the context_track split usually wrote it already); a
      // body-supplied or already-stored note is not re-written.
      await updateTrack(track.trackId, {
        observationAudioUrl: media.observationAudioUrl,
        observationDurationMs: durationMs,
        observationGeneratedAt: generatedAt,
        ...(freshlyFetched ? { contextNote } : {}),
      });

      return {
        audioUrl: media.observationAudioUrl,
        durationMs,
        generatedAt,
        jsonUrl: `${FOUND_BASE}/${base}/observation.json`,
        logId: track.logId,
        ok: true as const,
        textUrl: media.observationTextUrl,
        trackId: track.trackId,
        voiceId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/context — agent tier (`adminAuth` only).
  // The split-out context half: fetch the Firecrawl FACTS and write `context_note`
  // ONLY, quietly (track-update.ts does not bump updated_at for contextNote). The
  // Firecrawl output is UNTRUSTED web content treated strictly as DATA — assembled
  // into the note, stored as fuel, never executed as instructions.
  const contextTrackHandler = os.context_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const idOrLogId = input.trackId;
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
          message: `No track with id ${idOrLogId}`,
          status: 404,
        });
      }

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      // Idempotency (`context:${logId}`): a finding that already has a
      // context note is a no-op, so an external cron firing on a fixed interval
      // never re-burns the Firecrawl budget or overwrites the stored facts.
      const existing = await getTrackContextNote(track.trackId);

      if (existing?.trim()) {
        return {
          contextNote: existing,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          sources: [],
          trackId: track.trackId,
        };
      }

      // Fetch the FACTS (Firecrawl). The agent may override the search query; the
      // result is internal DATA. A best-effort empty note is still written-through
      // as "" so the queue (context_note IS NULL) does not re-pick it forever — but
      // a write-through of "" would still read as null-ish; only a non-empty note
      // advances the queue, so an empty fetch leaves it null for the next tick.
      const query =
        typeof input.query === "string" && input.query.trim()
          ? input.query.trim()
          : buildContextQuery(track);
      const fetched = await fetchTrackContext(query);

      if (fetched.contextNote.trim()) {
        // Quiet write: contextNote alone, so track-update.ts does NOT bump
        // updated_at (no public surface moves; the enrich-sweep stale clock and the
        // sitemap lastmod stay untouched).
        await updateTrack(track.trackId, { contextNote: fetched.contextNote });
      }

      return {
        contextNote: fetched.contextNote,
        logId: track.logId,
        ok: true as const,
        sources: fetched.sources,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/video/uploads — operator tier (live
  // `requireOperator`). The JSON control-plane: sign the direct-to-R2 PUT URLs.
  const presignVideoUploadsHandler = os.presign_track_video_uploads
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await getTrackByIdOrLogId(idOrLogId);

        if (!track) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
            message: `No track with id ${idOrLogId}`,
            status: 404,
          });
        }

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        const requested = Array.isArray(input.fields) ? (input.fields as unknown[]) : undefined;

        if (!requested || requested.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_fields",
              apiMessage: "List the artifact `fields` you want to upload",
            },
            message: "List the artifact `fields` you want to upload",
            status: 400,
          });
        }

        const artifacts: VideoArtifact[] = [];

        for (const field of requested) {
          if (typeof field !== "string") {
            throw new ORPCError("BAD_REQUEST", {
              data: { apiCode: "bad_field", apiMessage: "Each field must be a string" },
              message: "Each field must be a string",
              status: 400,
            });
          }

          const artifact = artifactByField(field);

          if (!artifact) {
            throw new ORPCError("BAD_REQUEST", {
              data: {
                apiCode: "unknown_field",
                apiMessage: `Unknown video artifact field: ${field}`,
              },
              message: `Unknown video artifact field: ${field}`,
              status: 400,
            });
          }

          artifacts.push(artifact);
        }

        if (!artifacts.some((artifact) => artifact.field === "footage")) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_footage",
              apiMessage: "A `footage` cut (footage.mp4) is required",
            },
            message: "A `footage` cut (footage.mp4) is required",
            status: 400,
          });
        }

        const signed = await presignUploads(
          VIDEOS_BUCKET,
          artifacts.map((artifact) => ({
            contentType: artifact.contentType,
            key: `${track.logId}/${artifact.name}`,
          })),
        );

        const uploads = signed.map((row, index) => ({
          contentType: row.contentType,
          field: artifacts[index].field,
          key: row.key,
          url: row.url,
        }));

        return { logId: track.logId, ok: true as const, trackId: track.trackId, uploads };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/video/finalize — operator tier (live
  // `requireOperator`). Phase 2: link the canonical web cut.
  const finalizeVideoHandler = os.finalize_track_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const body: AdminTrackInputs["finalize_track_video"] = input;
        const idOrLogId = body.trackId;
        const track = await getTrackByIdOrLogId(idOrLogId);

        if (!track) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
            message: `No track with id ${idOrLogId}`,
            status: 404,
          });
        }

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        const videoVehicle =
          typeof body.videoVehicle === "string" && body.videoVehicle.trim()
            ? body.videoVehicle.trim().slice(0, 120)
            : undefined;
        const videoModel =
          typeof body.videoModel === "string" && body.videoModel.trim()
            ? body.videoModel.trim().slice(0, 120)
            : "anthropic/claude-opus-4-8";
        const videoModelReasoning =
          typeof body.videoModelReasoning === "string" && body.videoModelReasoning.trim()
            ? body.videoModelReasoning.trim().slice(0, 120)
            : "high";

        const videoUrl = trackMedia(track.logId).videoUrl;
        // `squared` (the CLI sends it when it uploaded BOTH the square footage.mp4
        // and the portrait footage.social.mp4) flips the two-master layout on:
        // footage.mp4 is now the clean square crop source. Stamp the signal so the
        // archive surfaces start MT-cropping this finding (docs/video-variants.md).
        const squared = body.squared === true;

        await updateTrack(track.trackId, {
          videoModel,
          videoModelReasoning,
          videoUrl,
          ...(squared ? { videoSquaredAt: new Date().toISOString() } : {}),
          ...(videoVehicle ? { videoVehicle } : {}),
        });

        return { logId: track.logId, ok: true as const, trackId: track.trackId, videoUrl };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    add_track: addTrackHandler,
    context_track: contextTrackHandler,
    finalize_track_video: finalizeVideoHandler,
    list_tracks_admin: listTracksAdminHandler,
    observe_track: observeTrackHandler,
    presign_track_video_uploads: presignVideoUploadsHandler,
    update_track: updateTrackHandler,
  };
}
