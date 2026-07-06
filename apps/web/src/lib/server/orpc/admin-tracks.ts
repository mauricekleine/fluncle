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
//     agent tier (`adminAuth` only) so the Hermes observation cron can drive it.
//     Idempotent per finding (an
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
import { FOUND_BASE, trackMedia, videoVersion } from "../../media";
import { recordNoteAttempt } from "../backfill";
import { parseEditorialNote } from "../http-errors";
import { gateNoteText } from "../note";
import { publishTrack } from "../publish";
import {
  DEFAULT_CARTESIA_SPEED,
  type ObservationArtifact,
  buildContextQuery,
  fetchTrackContext,
  gateObservationScript,
  observationDurationFromAlignment,
  renderObservationCartesia,
  resolveCartesiaVoiceId,
} from "../observation";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { VIDEOS_BUCKET, presignUploads } from "../r2-presign";
import { type TrackUpdate, updateTrack } from "../track-update";
import { purgeVideoCache } from "../video-cache";
import {
  type EnrichmentStatusFilter,
  ENRICHMENT_STATUS_FILTERS,
  decodeTrackCursor,
  getTrackContextNote,
  listTracks,
  searchTracks,
} from "../tracks";
import { type VideoArtifact, artifactByField } from "../video-bundle";
import { type Implementer, parseLimit, requireTrack, toFault } from "./_shared";

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
type NoteBody = AdminTrackInputs["note_track"];

// Admin board list page-size bounds, ported verbatim from the live GET route.
const ADMIN_LIST_DEFAULT_LIMIT = 16;
const ADMIN_LIST_MAX_LIMIT = 48;

// Tri-state boolean query params ("true"/"false"/absent → true/false/undefined),
// ported verbatim from the live `hasVideo` route. `hasContext`/`hasObservation`/
// `hasNote` reuse it to drive the context, observation, and auto-note queues.
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

  // GET /admin/tracks/{trackId} — admin tier (live `requireAdmin`, agent-allowed).
  // The single-finding by-coordinate lookup: fetch ONE finding with its full
  // admin-tier fields (vibe coords, the video ledger, the observation, the note), or
  // the canonical 404. Distinct from list_tracks_admin — a single authoritative read,
  // so an ad-hoc list-scan can't misread a live finding as nonexistent. `requireTrack`
  // resolves by Spotify trackId OR Log ID and raises the shared `not_found`/404,
  // DISTINCT from the procedure's auth 401/403.
  const getTrackAdminHandler = os.get_track_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const track = await requireTrack(input.trackId);

      return { ok: true as const, track };
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
        hasKey: parseTriStateBool(input.hasKey),
        hasNote: parseTriStateBool(input.hasNote),
        hasObservation: parseTriStateBool(input.hasObservation),
        hasVideo: parseTriStateBool(input.hasVideo),
        limit: parseAdminLimit(input.limit),
        order: input.order === "asc" ? "asc" : "desc",
        retryEmptyContext: parseTriStateBool(input.retryEmptyContext) === true,
        status: parseEnrichmentStatus(input.status),
      });
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks — operator tier (live `requireOperator`). Publish a finding
  // from a Spotify URL, then kick off async enrichment.
  const publishTrackHandler = os.publish_track
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const body: AdminTrackInputs["publish_track"] = input;

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
        // `fluncle admin tracks update`.

        return { ok: true as const, ...result };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/observe — agent tier (`adminAuth` only). FLIPPED
  // from the operator tier so the Hermes observation cron drives it.
  const observeTrackHandler = os.observe_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: ObserveBody = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

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
      // a fixed interval — never spends a second Cartesia render or overwrites the
      // existing artifact. The versioned playback URL on the row is already keyed by
      // the prior render; report it back unchanged. `force` bypasses this for a
      // deliberate operator re-render (voice re-tune / fixing a degenerate render).
      const force = body.force === true;

      if (track.observationAudioUrl && !force) {
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
      const durationTargetSec = resolveDurationTargetSec(body.durationTargetSec);

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

      // Render via Cartesia Sonic: renderObservationCartesia clones-once → SSE (raw PCM
      // + word timestamps) → in-process MP3, returning `{ alignment, bytes, voiceId }`.
      // A missing/malformed alignment is `null` (captions degrade) — never a render fail.
      const cartesiaVoiceId = await resolveCartesiaVoiceId(
        typeof body.voiceId === "string" ? body.voiceId : undefined,
      );
      const { alignment, bytes, voiceId } = await renderObservationCartesia(cartesiaVoiceId, {
        text: script,
      });

      // Duration: Cartesia returns no clip length and the Worker can't probe (no
      // ffprobe). Prefer an explicit probed `body.durationMs`; absent it (the box cron
      // doesn't ffprobe), derive the REAL length from the alignment's last word —
      // since the radio segment length IS this duration (radio-schedule.ts), the old
      // `durationTargetSec * 1000` fallback clamped every read to 30s and cut the audio
      // at the seam. The 30s target only survives as a last resort when there's no
      // alignment at all. The radio page never re-probes.
      const durationMs =
        typeof body.durationMs === "number" &&
        Number.isFinite(body.durationMs) &&
        body.durationMs > 0
          ? Math.round(body.durationMs)
          : (observationDurationFromAlignment(alignment) ?? durationTargetSec * 1000);

      const media = trackMedia(track.logId);
      const generatedAt = new Date().toISOString();

      const artifact: ObservationArtifact = {
        ...(alignment ? { alignment } : {}),
        audioUrl: media.observationAudioUrl,
        ...(contextNote ? { contextNote } : {}),
        durationMs,
        durationTargetSec,
        generatedAt,
        logId: track.logId,
        provider: "cartesia",
        speed: DEFAULT_CARTESIA_SPEED,
        text: script,
        textUrl: media.observationTextUrl,
        trackId: track.trackId,
        voiceId,
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
      // (visible — they bump lastmod) + the spoken script (the transcript mirror of
      // observation.json `text`, so the admin dialog reads it from the row, not R2).
      // Backfill the context note only when this step freshly fetched it (the
      // context_track split usually wrote it already); a body-supplied or
      // already-stored note is not re-written.
      await updateTrack(track.trackId, {
        // The caption timings (when captured) — internal-but-public, not in
        // VISIBLE_FIELDS; the sibling observationAudioUrl bumps lastmod for the render.
        ...(alignment ? { observationAlignmentJson: JSON.stringify(alignment) } : {}),
        observationAudioUrl: media.observationAudioUrl,
        observationDurationMs: durationMs,
        observationGeneratedAt: generatedAt,
        observationScript: script,
        // A freshly-fetched-here note also marks `context_status = 'resolved'` so the
        // context queue (status-aware) treats this finding as done, mirroring the
        // split-out `context_track` step's write.
        ...(freshlyFetched ? { contextNote, contextStatus: "resolved" as const } : {}),
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
      const track = await requireTrack(idOrLogId);

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
      //
      // `refresh` (the CLI's `--refresh`) RE-RUNS the fetch+distil even when a note
      // already exists — the deliberate operator action to backfill/sharpen an old
      // context note (the auto-note's primary fuel). It costs a Firecrawl + distil
      // pass per call, so it is opt-in; the default stays the short-circuit so the
      // every-tick context cron never re-burns the budget on an already-noted find.
      const refresh = input.refresh === true || input.refresh === "true";
      const existing = await getTrackContextNote(track.trackId);

      if (existing?.trim() && !refresh) {
        return {
          contextNote: existing,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          sources: [],
          trackId: track.trackId,
        };
      }

      // Fetch the FACTS (Firecrawl) and DISTIL them into a clean note (OpenRouter).
      // The agent may override the search query; the result is internal DATA.
      const query =
        typeof input.query === "string" && input.query.trim()
          ? input.query.trim()
          : buildContextQuery(track);
      const fetched = await fetchTrackContext(query);

      // Persist the reliability marker alongside the note. The `context_status`
      // column makes a confirmed-empty fetch (`empty`) distinct from never-attempted
      // (NULL/`pending`), so the queue does not re-burn Firecrawl + the distil LLM on
      // a hopeless find every tick (`--retry-empty` re-picks `empty`; `failed` is a
      // vendor-down miss the next tick retries). All quiet: contextNote/contextStatus
      // are internal, so track-update.ts does NOT bump updated_at (no public surface
      // moves; the enrich-sweep stale clock and the sitemap lastmod stay untouched).
      if (fetched.status === "resolved" && fetched.contextNote.trim()) {
        await updateTrack(track.trackId, {
          contextNote: fetched.contextNote,
          contextStatus: "resolved",
        });
      } else if (refresh && existing?.trim()) {
        // A `--refresh` that re-fetched nothing usable must NOT downgrade a finding
        // that already had a good note: keep the prior note + its `resolved` status
        // rather than blanking the status to `empty`/`failed` and losing the fuel.
        // (No write at all — the row is already resolved.)
      } else {
        await updateTrack(track.trackId, { contextStatus: fetched.status });
      }

      // On a `--refresh` no-op (re-fetch found nothing usable but a note already
      // existed), report the PRESERVED note, not the empty re-fetch result.
      const contextNote =
        fetched.status === "resolved" && fetched.contextNote.trim()
          ? fetched.contextNote
          : refresh && existing?.trim()
            ? existing
            : fetched.contextNote;

      return {
        contextNote,
        logId: track.logId,
        ok: true as const,
        sources: fetched.sources,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/note — agent tier (`adminAuth` only). The
  // written-note sibling of observe_track: the agent authored the editorial note in
  // Fluncle's voice; this step VOICE-GATES it and stores it into the `note` field.
  // CARDINAL SAFETY: fills an EMPTY note ONLY — a finding with a note already
  // (operator-written OR previously auto-authored) is a no-op (`skipped: true`); the
  // operator override always wins, enforced here, server-side.
  const noteTrackHandler = os.note_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: NoteBody = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every finding needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every finding needs a coordinate.",
          status: 400,
        });
      }

      // THE FILL-EMPTY-ONLY GUARD (the cardinal safety guarantee). `track.note` is
      // `undefined` only when the stored note is empty/whitespace (toTrackListItem
      // trims it); any non-empty note — operator-written or previously auto-authored
      // — short-circuits to a no-op. The agent NEVER overwrites an existing note. We
      // still stamp the "ran" state (the workflow ran; it correctly found nothing to
      // do) so the board doesn't keep re-queuing a hand-noted finding.
      if (track.note?.trim()) {
        await recordNoteAttempt(track.trackId, false);

        return {
          logId: track.logId,
          note: track.note,
          ok: true as const,
          skipped: true as const,
          trackId: track.trackId,
        };
      }

      // Voice-gate the agent-authored note (defence in depth: the agent gates as it
      // writes; the Worker re-scans and hard-fails any violation before it is stored
      // — the note lands straight on the public /log surface).
      const note = gateNoteText(body.note);

      // Fill the empty note. `parseEditorialNote` re-validates the length against the
      // public budget on the same path an operator note takes; the gate already
      // checked it, so this is the byte-identical store, not a second source of truth.
      await updateTrack(track.trackId, { note: parseEditorialNote(note) });
      await recordNoteAttempt(track.trackId, true);

      return {
        logId: track.logId,
        note,
        ok: true as const,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/video/uploads — agent tier (any admin principal,
  // operator OR agent): the autonomous render box publishes its own renders. The JSON
  // control-plane: sign the direct-to-R2 PUT URLs.
  const presignVideoUploadsHandler = os.presign_track_video_uploads
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

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

        const requested = Array.isArray(input.fields) ? input.fields : undefined;

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

        // The one sanctioned footage-less upload: the plate-lane PRE-upload. Plates
        // (plate.png + plate.background.png) go up BEFORE the composition exists so
        // the composition can reference the durable found.fluncle.com URL — the
        // upload-first order. Any other footage-less set still 400s.
        const platesOnly =
          artifacts.length > 0 &&
          artifacts.every(
            (artifact) => artifact.field === "plate" || artifact.field === "plate-background",
          );

        if (!platesOnly && !artifacts.some((artifact) => artifact.field === "footage")) {
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

        const uploads = signed.map((row, index) => {
          const artifact = artifacts[index];
          if (artifact === undefined) {
            throw new Error("Presigned upload row has no matching artifact");
          }

          return {
            contentType: row.contentType,
            field: artifact.field,
            key: row.key,
            url: row.url,
          };
        });

        return { logId: track.logId, ok: true as const, trackId: track.trackId, uploads };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/video/finalize — agent tier (any admin principal,
  // operator OR agent): the autonomous render box links its own cut. Phase 2: link the
  // canonical web cut (sets video_url).
  const finalizeVideoHandler = os.finalize_track_video.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: AdminTrackInputs["finalize_track_video"] = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

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
      const videoGrain =
        typeof body.videoGrain === "string" && body.videoGrain.trim()
          ? body.videoGrain.trim().slice(0, 120)
          : undefined;
      const videoRegister =
        typeof body.videoRegister === "string" && body.videoRegister.trim()
          ? body.videoRegister.trim().slice(0, 120)
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
      // archive surfaces start MT-cropping this finding.
      const squared = body.squared === true;

      // A RE-RENDER: this finding already had a `video_url` (the prior render),
      // and finalize re-ships `footage.mp4` to the SAME R2 key. The bare master
      // URL is byte-identical (the queue gates on presence, not content), so the
      // DB write below is a no-op for `video_url` — but stale renditions live on.
      // The NEW `videoSquaredAt` below is the vintage every surface rides as the
      // transform `?v` token (media.ts `videoVersion`), which is what actually
      // evicts MT's internally-cached renditions; the purge covers the bare R2
      // objects + any zone-edge copies. Best-effort, fired off the request
      // lifecycle (waitUntil) BELOW after the DB write commits.
      const squaredAt = squared ? new Date().toISOString() : undefined;

      await updateTrack(track.trackId, {
        videoModel,
        videoModelReasoning,
        videoUrl,
        ...(squaredAt ? { videoSquaredAt: squaredAt } : {}),
        ...(videoVehicle ? { videoVehicle } : {}),
        ...(videoGrain ? { videoGrain } : {}),
        ...(videoRegister ? { videoRegister } : {}),
      });

      // Drop stale edge entries on EVERY finalize, not just when track.videoUrl was
      // already set: the requeue flow clears video_url to re-queue a finding, so a
      // re-render's finalize sees no prior url and would otherwise skip the purge (the
      // gap the manual heartbeat used to cover). On a genuine first render nothing is
      // cached yet, so this is a harmless no-op. `squared` reflects the layout the
      // finding now carries, so the purge set matches what the surfaces will request —
      // built with the NEW vintage, the same `?v` the surfaces mint from now on.
      purgeVideoCache(
        track.logId,
        squared || Boolean(track.videoSquaredAt),
        videoVersion(squaredAt ?? track.videoSquaredAt),
      );

      return { logId: track.logId, ok: true as const, trackId: track.trackId, videoUrl };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/video/requeue — operator tier (live
  // `requireOperator`). Clear a finding's video so it re-enters the render queue AND
  // drops cleanly off radio until re-rendered. This removes a LIVE published video,
  // so it is operator-only (NOT agent-tier — the box agent never clears videos).
  //
  // It clears BOTH display/queue gates, the minimal set that fully returns a finding
  // to "no video": `video_url` (the render queue's gate — `hasVideo=false` is
  // `video_url is null`) and `video_squared_at` (radio's eligibility gate). Clearing
  // only `video_url` would re-queue it but leave it eligible-but-broken on radio (no
  // playable square-master source). The ledger columns (videoVehicle/videoGrain/
  // videoModel/videoModelReasoning) are LEFT INTACT on purpose — they describe the
  // prior render and the next video agent reads them to diversify away from it.
  //
  // CACHE NOTE: re-shipping footage.mp4 to the same R2 key leaves Cloudflare
  // Media-Transformation renditions cached separately (the player streams MT crops,
  // not the master). finalize_track_video now purges them automatically on a
  // re-render; purge_video (below) is the manual operator twin.
  const requeueVideoHandler = os.requeue_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

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

        // Idempotent: a finding already at "no video" is a clean no-op — skip the
        // write entirely (no needless updateTrack/cache purge), report alreadyClear.
        if (!track.videoUrl && !track.videoSquaredAt) {
          return {
            alreadyClear: true as const,
            logId: track.logId,
            ok: true as const,
            trackId: track.trackId,
          };
        }

        // Clear both gates. updateTrack maps an empty string to NULL for each (the
        // documented "remove an off-direction video" + re-render paths), so the
        // `video_url is not null` queue filter and the `video_squared_at is not null`
        // radio filter both drop this finding until it is re-rendered.
        await updateTrack(track.trackId, { videoSquaredAt: "", videoUrl: "" });

        return { logId: track.logId, ok: true as const, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/video/purge — operator tier (live
  // `requireOperator`). The manual twin of the automatic re-render purge in
  // finalize: evict this finding's stale Cloudflare Media-Transformation renditions
  // from the edge (the player streams MT crops, not the master, so a same-key
  // re-upload leaves the renditions stale). Operator-only — it acts on a LIVE video.
  const purgeVideoHandler = os.purge_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

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

        // No video → nothing cached to purge. Report the no-op rather than firing a
        // pointless purge of URLs that resolve to a missing master.
        if (!track.videoUrl) {
          return {
            logId: track.logId,
            noVideo: true as const,
            ok: true as const,
            trackId: track.trackId,
          };
        }

        // Fire-and-forget (waitUntil inside). `squared` mirrors the finding's layout
        // so the purge set matches the rendition family the surfaces actually serve.
        purgeVideoCache(
          track.logId,
          Boolean(track.videoSquaredAt),
          videoVersion(track.videoSquaredAt),
        );

        return { logId: track.logId, ok: true as const, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    context_track: contextTrackHandler,
    finalize_track_video: finalizeVideoHandler,
    get_track_admin: getTrackAdminHandler,
    list_tracks_admin: listTracksAdminHandler,
    note_track: noteTrackHandler,
    observe_track: observeTrackHandler,
    presign_track_video_uploads: presignVideoUploadsHandler,
    publish_track: publishTrackHandler,
    purge_video: purgeVideoHandler,
    requeue_video: requeueVideoHandler,
    update_track: updateTrackHandler,
  };
}
