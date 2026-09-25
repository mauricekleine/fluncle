import { authMiddlewaresOf } from "./orpc-backpressure";

const CORS_EXCLUDED_OPERATIONS = new Set<string>([
  "get_replica_token",

  "get_current_private_user",
]);

const CORS_ALLOWED_METHODS = "GET, OPTIONS";

const CORS_ALLOWED_HEADERS = "Accept, Content-Type";

const CORS_MAX_AGE = "86400";

const PATH_PARAM = /\{[^}]+\}/g;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function templateToPattern(template: string): RegExp {
  const source = template
    .split(PATH_PARAM)
    .map((literal) => literal.replace(REGEX_SPECIAL, "\\$&"))
    .join("[^/]+");

  return new RegExp(`^${source}$`);
}

type RouterOp = {
  "~orpc"?: {
    middlewares?: unknown[];
    route?: { method?: string; path?: string };
  };
};

export function buildPublicCorsMatcher(router: Record<string, unknown>): (path: string) => boolean {
  const patterns: RegExp[] = [];

  for (const [name, op] of Object.entries(router)) {
    const meta = (op as RouterOp)["~orpc"];
    const path = meta?.route?.path;

    const method = meta?.route?.method ?? "GET";

    if (
      path === undefined ||
      method !== "GET" ||
      authMiddlewaresOf(meta?.middlewares ?? []).length > 0 ||
      CORS_EXCLUDED_OPERATIONS.has(name)
    ) {
      continue;
    }

    patterns.push(templateToPattern(path));
  }

  return (path: string) => patterns.some((pattern) => pattern.test(path));
}

function corsHeaders(): [string, string][] {
  return [
    ["Access-Control-Allow-Origin", "*"],
    ["Access-Control-Allow-Methods", CORS_ALLOWED_METHODS],
    ["Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS],
    ["Access-Control-Max-Age", CORS_MAX_AGE],
  ];
}

export function corsPreflightResponse(
  request: Request,
  path: string,
  isPublicRead: (path: string) => boolean,
): Response | undefined {
  if (
    request.method !== "OPTIONS" ||
    request.headers.get("access-control-request-method") === null ||
    !isPublicRead(path)
  ) {
    return undefined;
  }

  const headers = new Headers();

  for (const [name, value] of corsHeaders()) {
    headers.set(name, value);
  }

  return new Response(null, { headers, status: 204 });
}

export function applyPublicCors(
  request: Request,
  path: string,
  response: Response,
  isPublicRead: (path: string) => boolean,
): void {
  if (request.method !== "GET" || !isPublicRead(path)) {
    return;
  }

  for (const [name, value] of corsHeaders()) {
    response.headers.set(name, value);
  }
}
