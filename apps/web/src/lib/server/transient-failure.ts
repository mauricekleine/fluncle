import { requestSawTransientDatabaseFailure } from "./db";
import { edgeCachePolicyFor, isPublicHtmlPagePath } from "./edge-cache";

export const TRANSIENT_FAILURE_RETRY_AFTER_SECONDS = 60;

export function withTransientDatabaseFailure(request: Request, response: Response): Response {
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    response.status < 500 ||
    response.status > 599 ||
    response.status === 503 ||
    !requestSawTransientDatabaseFailure()
  ) {
    return response;
  }

  const { pathname, search } = new URL(request.url);
  if (edgeCachePolicyFor(pathname, search) === undefined && !isPublicHtmlPagePath(pathname)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(TRANSIENT_FAILURE_RETRY_AFTER_SECONDS));
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { headers, status: 503 });
}
