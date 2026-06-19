import { NOTE_MAX_LENGTH } from "../log-prose";
import { jsonError } from "./env";
import { ApiError } from "./spotify";

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonError(error.status, error.code, error.message);
  }

  return jsonError(500, "error", error instanceof Error ? error.message : String(error));
}

/** The canonical 404 for a track lookup by id or Log ID. */
export function trackNotFoundResponse(id: string): Response {
  return jsonError(404, "not_found", `No track with id ${id}`);
}

/** The canonical 400 for a track that has no Log ID (video/social flows need one). */
export function noLogIdResponse(): Response {
  return jsonError(
    400,
    "no_log_id",
    "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
  );
}

/**
 * Parse a request body as JSON, returning a 400 `invalid_request` Response when
 * the body is malformed (so a bad body becomes a clean 400, not an uncaught
 * throw). On success returns `{ json }` — callers narrow the `unknown` themselves
 * (these are untrusted inputs).
 */
export async function parseJsonBody(request: Request): Promise<Response | { json: unknown }> {
  try {
    return { json: await request.json() };
  } catch {
    return jsonError(400, "invalid_request", "Malformed JSON body");
  }
}

/**
 * Parse + validate an editorial note from an untrusted request body. Returns the
 * trimmed note (including `""`, which means "clear the note"); returns `undefined`
 * only when the field is absent (not a string). Throws `ApiError("note_too_long",
 * …, 422)` when it exceeds the budget. Call inside a try block whose catch uses
 * `apiErrorResponse` so the throw becomes a clean 422.
 *
 * Semantics differ by caller: the add path treats `""` as "no note" (omit it);
 * the PATCH path treats `""` as "clear the stored note" (set it). Gate on
 * `typeof value === "string"` at the call site to distinguish present-from-absent.
 */
export function parseEditorialNote(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new ApiError("note_too_long", `Note must be ${NOTE_MAX_LENGTH} characters or less`, 422);
  }

  return trimmed;
}
