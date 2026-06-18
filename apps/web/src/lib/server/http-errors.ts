import { jsonError } from "./env";
import { ApiError } from "./spotify";

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonError(error.status, error.code, error.message);
  }

  return jsonError(500, "error", error instanceof Error ? error.message : String(error));
}
