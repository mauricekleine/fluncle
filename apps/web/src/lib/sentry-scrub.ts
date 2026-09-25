export const FILTERED = "[Filtered]";

export const SENSITIVE_URL_PARAMS = [
  "callbackURL",
  "code",
  "digestToken",
  "errorCallbackURL",
  "follow",
  "intent",
  "newUserCallbackURL",
  "state",
  "token",
  "unsubscribe",
] as const;

const SENSITIVE_PARAM_KEYS = new Set<string>(SENSITIVE_URL_PARAMS.map((key) => key.toLowerCase()));

const SENSITIVE_OBJECT_KEYS = new Set<string>(
  [
    "callbackURL",
    "digestToken",
    "errorCallbackURL",
    "follow",
    "intent",
    "newUserCallbackURL",
    "token",
    "unsubscribe",
  ].map((key) => key.toLowerCase()),
);

const PARAM_NAMES = SENSITIVE_URL_PARAMS.join("|");

const QUERY_PARAM = new RegExp(`((?:^|[?&#;\\s])(?:${PARAM_NAMES})=)[^&#\\s"'<>]*`, "gi");

const ENCODED_QUERY_PARAM = new RegExp(
  `((?:%3F|%26)(?:${PARAM_NAMES})%3D)(?:(?!%26|%23)[^&#\\s"'<>])*`,
  "gi",
);

const TOKEN_IN_PATH = /(\/reset-password\/)[^/?#\s"'<>]+/g;

const MAX_DEPTH = 10;

export function scrubSensitiveText(value: string): string {
  return value
    .replace(QUERY_PARAM, `$1${FILTERED}`)
    .replace(ENCODED_QUERY_PARAM, `$1${FILTERED}`)
    .replace(TOKEN_IN_PATH, `$1${FILTERED}`);
}

function isSensitiveParam(key: unknown): boolean {
  return typeof key === "string" && SENSITIVE_PARAM_KEYS.has(key.toLowerCase());
}

function isSensitiveField(key: string): boolean {
  return SENSITIVE_OBJECT_KEYS.has(key.toLowerCase());
}

export function scrubSensitiveValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") {
    return scrubSensitiveText(value) as T;
  }

  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 2 && isSensitiveParam(value[0])) {
      return [value[0], FILTERED] as T;
    }

    return value.map((entry: unknown) => scrubSensitiveValue(entry, depth + 1)) as T;
  }

  const scrubbed: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    scrubbed[key] = isSensitiveField(key) ? FILTERED : scrubSensitiveValue(entry, depth + 1);
  }

  return scrubbed as T;
}

export const browserSentryScrubHooks = {
  beforeBreadcrumb: <T>(breadcrumb: T): T => scrubSensitiveValue(breadcrumb),
  beforeSend: <T>(event: T): T => scrubSensitiveValue(event),
  beforeSendTransaction: <T>(event: T): T => scrubSensitiveValue(event),
};
