import { NOTE_MAX_LENGTH } from "../log-prose";
import { jsonError } from "./env";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonError(error.status, error.code, error.message);
  }

  logEvent("error", "api.unexpected-fault", { error });
  return jsonError(500, "error", "Internal error");
}

export function trackNotFoundResponse(id: string): Response {
  return jsonError(404, "not_found", `No track with id ${id}`);
}

export function requireParam(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new ApiError("invalid_request", `Missing path parameter '${name}'`, 400);
  }

  return value;
}

export async function parseJsonBody(request: Request): Promise<Response | { json: unknown }> {
  try {
    return { json: await request.json() };
  } catch {
    return jsonError(400, "invalid_request", "Malformed JSON body");
  }
}

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
