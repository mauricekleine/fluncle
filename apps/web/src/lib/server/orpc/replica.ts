// The `replica` domain router module. The Worker only mints a short-lived,
// read-only credential; devices sync the shared catalogue replica directly.

import { ORPCError } from "@orpc/server";
import { type FetchImpl, readOptionalEnv } from "../env";
import { assertRateLimit } from "../rate-limit";
import { apiFault, type Implementer } from "./_shared";

const REPLICA_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPLICA_TOKEN_EXPIRATION = "1d";
const REPLICA_TOKEN_LIMIT = 2;
const REPLICA_TOKEN_WINDOW_MS = 60 * 60 * 1000;
const TURSO_PLATFORM_API = "https://api.turso.tech/v1";

type ReplicaConfig = {
  databaseName: string;
  databaseUrl: string;
  organization: string;
  platformToken: string;
};

function replicaUnavailable(): ORPCError<string, { apiCode: string; apiMessage: string }> {
  return new ORPCError("SERVICE_UNAVAILABLE", {
    data: {
      apiCode: "replica_unavailable",
      apiMessage: "The device replica is unavailable.",
    },
    message: "The device replica is unavailable.",
    status: 503,
  });
}

/**
 * Read the four OPTIONAL bindings as one all-or-nothing feature flag:
 *
 * - DEVICE_REPLICA_DB_URL — the libSQL URL returned to devices.
 * - DEVICE_REPLICA_DB_NAME — the database name in the Platform API path.
 * - TURSO_PLATFORM_ORG — the organization slug in the Platform API path.
 * - TURSO_PLATFORM_TOKEN — the secret bearer used only to mint database tokens.
 *
 * A partial or absent configuration keeps the endpoint dark and becomes the
 * typed `replica_unavailable` fault; it never falls into a generic 500.
 */
async function readReplicaConfig(): Promise<ReplicaConfig | undefined> {
  const [databaseUrl, databaseName, organization, platformToken] = await Promise.all([
    readOptionalEnv("DEVICE_REPLICA_DB_URL"),
    readOptionalEnv("DEVICE_REPLICA_DB_NAME"),
    readOptionalEnv("TURSO_PLATFORM_ORG"),
    readOptionalEnv("TURSO_PLATFORM_TOKEN"),
  ]);

  if (!databaseUrl || !databaseName || !organization || !platformToken) {
    return undefined;
  }

  try {
    if (new URL(databaseUrl).protocol !== "libsql:") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return { databaseName, databaseUrl, organization, platformToken };
}

async function mintReplicaToken(
  config: ReplicaConfig,
  fetchImpl: FetchImpl = fetch,
): Promise<{ expiresAt: string; token: string; url: string }> {
  // Compute from request start, not response receipt: the published expiry is
  // conservatively no later than Turso's own 24-hour lease, even after network
  // latency. A client may refresh early; it must never trust an already-expired JWT.
  const expiresAt = new Date(Date.now() + REPLICA_TOKEN_LIFETIME_MS).toISOString();
  const path = `/organizations/${encodeURIComponent(config.organization)}/databases/${encodeURIComponent(config.databaseName)}/auth/tokens`;
  const url = new URL(`${TURSO_PLATFORM_API}${path}`);
  url.searchParams.set("authorization", "read-only");
  url.searchParams.set("expiration", REPLICA_TOKEN_EXPIRATION);

  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.platformToken}` },
      method: "POST",
    });
  } catch {
    throw replicaUnavailable();
  }

  if (!response.ok) {
    throw replicaUnavailable();
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw replicaUnavailable();
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("jwt" in body) ||
    typeof body.jwt !== "string" ||
    body.jwt.length === 0
  ) {
    throw replicaUnavailable();
  }

  return { expiresAt, token: body.jwt, url: config.databaseUrl };
}

/**
 * Build the public replica-token handler. The configuration check comes before
 * the limiter so an intentionally dark deployment performs neither an app-DB
 * write nor a Platform API call. Once configured, the shared anonymous limiter
 * keys the request on Cloudflare's trusted connecting IP.
 */
export function replicaHandlers(os: Implementer) {
  const getReplicaTokenHandler = os.get_replica_token.handler(async ({ context }) => {
    try {
      const config = await readReplicaConfig();

      if (!config) {
        throw replicaUnavailable();
      }

      await assertRateLimit({
        action: "get_replica_token",
        limit: REPLICA_TOKEN_LIMIT,
        request: context.request,
        windowMs: REPLICA_TOKEN_WINDOW_MS,
      });

      return await mintReplicaToken(config);
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { get_replica_token: getReplicaTokenHandler };
}
