/**
 * Positive target gate for the destructive hosted scale bench.
 *
 * A denylist can only recognize names it already knows. This gate additionally requires the
 * operator to supply the target URL's exact canonical host as an independent identity value before
 * the bench may construct a client, migrate, seed, or trial-drop an index.
 */
export const SCALE_BENCH_URL_ENV = "SCRATCH_TURSO_DATABASE_URL";
export const SCALE_BENCH_TOKEN_ENV = "SCRATCH_TURSO_AUTH_TOKEN";
export const SCALE_BENCH_IDENTITY_ENV = "SCRATCH_TURSO_DATABASE_IDENTITY";

export type ScaleBenchTarget = {
  authToken: string;
  identity: string;
  url: string;
};

type ScaleBenchTargetGate = {
  readEnvironment?: (name: string) => string | undefined;
};

function parseHostedScratchUrl(rawUrl: string): { identity: string; url: string } {
  const url = rawUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("bench-db-scale: scratch database URL is invalid");
  }

  if (parsed.protocol !== "libsql:") {
    throw new Error("bench-db-scale: scratch database URL must use libsql://");
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(
      "bench-db-scale: scratch database URL must contain only one hosted database origin",
    );
  }

  const publicIdentifier = parsed.host.toLowerCase();
  const forbidden = [
    /(^|[._/-])prod($|[._/-])/,
    /(^|[._/-])production($|[._/-])/,
    /(^|[._/-])dev($|[._/-])/,
    /(^|[._/-])development($|[._/-])/,
    /(^|[._/-])local($|[._/-])/,
    /(^|[._/-])fluncle($|[._/-])/,
  ];

  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    forbidden.some((pattern) => pattern.test(publicIdentifier))
  ) {
    throw new Error(
      "bench-db-scale: scratch database URL resembles a production, development, or local target",
    );
  }

  return { identity: parsed.host, url };
}

/** Resolve and positively identify the hosted target before reading its token or constructing a client. */
export function resolveScaleBenchTarget(gate: ScaleBenchTargetGate = {}): ScaleBenchTarget {
  const readEnvironment = gate.readEnvironment ?? ((name: string) => process.env[name]);
  const rawUrl = readEnvironment(SCALE_BENCH_URL_ENV);
  const confirmedIdentity = readEnvironment(SCALE_BENCH_IDENTITY_ENV);

  if (!rawUrl || !confirmedIdentity) {
    throw new Error(
      `bench-db-scale: ${SCALE_BENCH_URL_ENV} and ${SCALE_BENCH_IDENTITY_ENV} are required`,
    );
  }

  const target = parseHostedScratchUrl(rawUrl);
  if (confirmedIdentity !== target.identity) {
    throw new Error(
      `bench-db-scale: ${SCALE_BENCH_IDENTITY_ENV} must exactly match the scratch URL host`,
    );
  }

  const authToken = readEnvironment(SCALE_BENCH_TOKEN_ENV)?.trim();
  if (!authToken) {
    throw new Error(`bench-db-scale: ${SCALE_BENCH_TOKEN_ENV} is required`);
  }

  return { authToken, identity: target.identity, url: target.url };
}
