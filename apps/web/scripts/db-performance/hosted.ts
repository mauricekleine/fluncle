export const HOSTED_SCRATCH_URL_ENV = "FLUNCLE_DB_PERF_SCRATCH_URL";
export const HOSTED_SCRATCH_TOKEN_ENV = "FLUNCLE_DB_PERF_SCRATCH_TOKEN";

export type HostedReplayConfiguration =
  | { mode: "local" }
  | { mode: "hosted"; token: string; url: string };

export type HostedReplayGate = {
  hosted: boolean;
  operatorApproved: boolean;
  readEnvironment?: (name: string) => string | undefined;
};

function validateScratchUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("hosted replay scratch URL is invalid");
  }

  if (parsed.protocol !== "libsql:" && parsed.protocol !== "https:") {
    throw new Error("hosted replay requires a libsql:// or https:// scratch URL");
  }

  const publicIdentifier = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
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
    throw new Error("hosted replay URL resembles a production, development, or local database");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "hosted replay URL must not contain credentials, query parameters, or fragments",
    );
  }

  return url;
}

/**
 * Local mode returns before touching the environment. Hosted credentials are read only after both
 * explicit gates are present, then validated before a client can be constructed.
 */
export function resolveHostedReplay(gate: HostedReplayGate): HostedReplayConfiguration {
  if (!gate.hosted) {
    if (gate.operatorApproved) {
      throw new Error("operator approval is inert without the explicit --hosted flag");
    }

    return { mode: "local" };
  }

  if (!gate.operatorApproved) {
    throw new Error("hosted replay requires explicit operator approval");
  }

  const readEnvironment = gate.readEnvironment ?? ((name: string) => process.env[name]);
  const rawUrl = readEnvironment(HOSTED_SCRATCH_URL_ENV);
  const token = readEnvironment(HOSTED_SCRATCH_TOKEN_ENV)?.trim();

  if (!rawUrl || !token) {
    throw new Error("hosted replay requires an explicit scratch URL and token");
  }

  if (token.length < 16) {
    throw new Error("hosted replay scratch token is invalid");
  }

  return { mode: "hosted", token, url: validateScratchUrl(rawUrl) };
}
