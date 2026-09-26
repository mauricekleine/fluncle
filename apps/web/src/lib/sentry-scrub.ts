export const FILTERED = "[Filtered]";

export const SENSITIVE_URL_PARAMS = [
  "access_token",
  "callbackURL",
  "code",
  "code_verifier",
  "device_code",
  "digestToken",
  "errorCallbackURL",
  "follow",
  "id_token",
  "intent",
  "newUserCallbackURL",
  "otp",
  "password",
  "refresh_token",
  "state",
  "token",
  "unsubscribe",
  "user_code",
] as const;

const SENSITIVE_PARAM_KEYS = new Set<string>(SENSITIVE_URL_PARAMS.map((key) => key.toLowerCase()));

const SENSITIVE_OBJECT_KEYS = new Set<string>(
  [
    "access_token",
    "callbackURL",
    "code_verifier",
    "device_code",
    "digestToken",
    "errorCallbackURL",
    "follow",
    "id_token",
    "intent",
    "newUserCallbackURL",
    "refresh_token",
    "token",
    "unsubscribe",
    "user_code",
  ].map((key) => key.toLowerCase()),
);

const CREDENTIAL_ROUTES = [
  /^\/api\/auth\/magic-link\//i,
  /^\/api\/auth\/reset-password(?:\/|$)/i,
  /^\/api\/auth\/verify-email(?:\/|$)/i,
  /^\/api\/auth\/callback\//i,
  /^\/api\/auth\/device(?:\/|$)/i,
  /^\/reset-password(?:\/|$)/i,
  /^\/device(?:\/|$)/i,
  /^\/follows(?:\/|$)/i,
  /^\/api\/(?:v1\/)?follow-digest\//i,
  /^\/api\/(?:v1\/)?admin\/[^/]+\/auth\/callback(?:\/|$)/i,
];

const TOKEN_IN_PATH = /(\/reset-password\/)[^/?#\s"'<>]+/gi;

const MAX_DECODE_ROUNDS = 6;

const MAX_DEPTH = 10;

const PARSE_BASE = "http://scrub.invalid";

const URLISH_TOKEN = /[^\s"'<>()[\]{}|\\^`,]+/g;

export function decodeFully(value: string): string {
  let current = value;

  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;

    try {
      next = decodeURIComponent(current.replace(/\+/g, " "));
    } catch {
      next = current.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }

    if (next === current) {
      return next;
    }

    current = next;
  }

  return current;
}

export function isSensitiveParamName(name: string): boolean {
  return SENSITIVE_PARAM_KEYS.has(decodeFully(name).trim().toLowerCase());
}

function isSensitiveField(key: string): boolean {
  return SENSITIVE_OBJECT_KEYS.has(decodeFully(key).trim().toLowerCase());
}

function isCredentialRoute(pathname: string): boolean {
  return CREDENTIAL_ROUTES.some((route) => route.test(pathname));
}

function scrubParams(query: string, depth: number): string {
  const params = new URLSearchParams(query);
  const out: string[] = [];

  for (const [name, value] of params) {
    const cleanName = decodeFully(name);
    const cleanValue = isSensitiveParamName(name) ? FILTERED : scrubUrlish(value, depth + 1);

    out.push(`${cleanName}=${cleanValue}`);
  }

  return out.join("&");
}

function scrubUrlish(raw: string, depth: number): string {
  if (depth > MAX_DEPTH) {
    return FILTERED;
  }

  const decoded = decodeFully(raw);

  if (!/[?#=/]/.test(decoded)) {
    return decoded === raw ? raw : decoded;
  }

  const looksLikeUrl = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(decoded);

  if (!looksLikeUrl) {
    return decoded.includes("=") ? scrubParams(decoded, depth) : decoded;
  }

  let url: URL;

  try {
    url = new URL(decoded, PARSE_BASE);
  } catch {
    return decoded.replace(TOKEN_IN_PATH, `$1${FILTERED}`);
  }

  const relative = url.origin === PARSE_BASE;
  const origin = relative ? "" : url.origin;
  const pathname = url.pathname.replace(TOKEN_IN_PATH, `$1${FILTERED}`);

  if (isCredentialRoute(url.pathname)) {
    const hadQuery = url.search.length > 0 || url.hash.length > 0;

    return `${origin}${pathname}${hadQuery ? `?${FILTERED}` : ""}`;
  }

  const search = url.search.length > 1 ? `?${scrubParams(url.search.slice(1), depth)}` : "";
  const hashBody = url.hash.slice(1);
  const hash =
    hashBody.length === 0
      ? ""
      : `#${hashBody.includes("=") ? scrubParams(hashBody, depth) : hashBody}`;

  return `${origin}${pathname}${search}${hash}`;
}

function scrubToken(token: string): string {
  if (!/[?#=%/]/.test(token)) {
    return token;
  }

  const scrubbed = scrubUrlish(token, 0);

  return decodeFully(token) === scrubbed ? token : scrubbed;
}

const SAFETY_NET = new RegExp(
  `((?:^|[?&#;\\s])(?:${SENSITIVE_URL_PARAMS.join("|")})=)[^&#\\s"'<>]*`,
  "gi",
);

export function scrubSensitiveText(value: string): string {
  const structured = value.replace(URLISH_TOKEN, scrubToken);

  return decodeFully(structured) === structured
    ? structured.replace(SAFETY_NET, `$1${FILTERED}`)
    : structured;
}

const QUERY_CONTAINERS = new Set([
  "params",
  "query",
  "query_string",
  "querystring",
  "search",
  "searchparams",
]);

export function scrubSensitiveValue<T>(value: T, depth = 0, inQuery = false): T {
  if (typeof value === "string") {
    return scrubSensitiveText(value) as T;
  }

  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "string" && isSensitiveParamName(value[0])) {
      return [value[0], FILTERED] as T;
    }

    return value.map((entry: unknown) => scrubSensitiveValue(entry, depth + 1, inQuery)) as T;
  }

  const scrubbed: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    scrubbed[key] =
      isSensitiveField(key) || (inQuery && isSensitiveParamName(key))
        ? FILTERED
        : scrubSensitiveValue(entry, depth + 1, QUERY_CONTAINERS.has(key.toLowerCase()));
  }

  return scrubbed as T;
}

export const browserSentryScrubHooks = {
  beforeBreadcrumb: <T>(breadcrumb: T): T => scrubSensitiveValue(breadcrumb),
  beforeSend: <T>(event: T): T => scrubSensitiveValue(event),
  beforeSendTransaction: <T>(event: T): T => scrubSensitiveValue(event),
};
