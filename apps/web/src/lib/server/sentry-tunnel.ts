import { BROWSER_SENTRY_DSN, SENTRY_TUNNEL_PATH, WORKER_SENTRY_DSN } from "../sentry-config";

export const SENTRY_TUNNEL_MAX_BYTES = 1024 * 1024;

function sentryDestination(dsn: string) {
  const url = new URL(dsn);

  return {
    host: url.host,
    projectId: url.pathname.replace(/^\/+|\/+$/g, ""),
    protocol: url.protocol,
  };
}

const allowedDestinations = [BROWSER_SENTRY_DSN, WORKER_SENTRY_DSN].map(sentryDestination);

export function isSentryTunnelRequest(request: Request): boolean {
  return new URL(request.url).pathname === SENTRY_TUNNEL_PATH;
}

function tunnelError(status: number, code: string, message: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");

  return Response.json({ code, message, ok: false }, { headers: responseHeaders, status });
}

export async function handleSentryTunnel(
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") {
    return tunnelError(405, "method_not_allowed", "Use POST.", { Allow: "POST" });
  }

  if (Number(request.headers.get("content-length")) > SENTRY_TUNNEL_MAX_BYTES) {
    return tunnelError(413, "payload_too_large", "Envelope is too large.");
  }

  const encoding = request.headers.get("content-encoding");

  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    return tunnelError(415, "unsupported_encoding", "Envelope must be uncompressed.");
  }

  if (!request.body) {
    return tunnelError(400, "invalid_envelope", "Invalid envelope header.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > SENTRY_TUNNEL_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return tunnelError(413, "payload_too_large", "Envelope is too large.");
      }

      chunks.push(value);
    }
  } catch {
    return tunnelError(400, "invalid_envelope", "Could not read envelope.");
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const newline = body.indexOf(10);

  if (newline < 0) {
    return tunnelError(400, "invalid_envelope", "Invalid envelope header.");
  }

  let destination: ReturnType<typeof sentryDestination>;

  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(body.subarray(0, newline)));

    if (
      !header ||
      typeof header !== "object" ||
      !("dsn" in header) ||
      typeof header.dsn !== "string"
    ) {
      return tunnelError(400, "invalid_envelope", "Invalid envelope header.");
    }

    destination = sentryDestination(header.dsn);
  } catch {
    return tunnelError(400, "invalid_envelope", "Invalid envelope header.");
  }

  if (
    destination.protocol !== "https:" ||
    !allowedDestinations.some(
      (allowed) => allowed.host === destination.host && allowed.projectId === destination.projectId,
    )
  ) {
    return tunnelError(400, "invalid_dsn", "Unsupported Sentry destination.");
  }

  try {
    const upstream = await fetchImpl(
      `https://${destination.host}/api/${destination.projectId}/envelope/`,
      {
        body,
        headers: { "Content-Type": "application/x-sentry-envelope" },
        method: "POST",
      },
    );
    const headers = new Headers({ "Cache-Control": "no-store" });

    for (const name of ["retry-after", "x-sentry-rate-limits"]) {
      const value = upstream.headers.get(name);

      if (value !== null) {
        headers.set(name, value);
      }
    }

    return new Response(upstream.body, { headers, status: upstream.status });
  } catch {
    return tunnelError(502, "upstream_unavailable", "Sentry is unavailable.");
  }
}
