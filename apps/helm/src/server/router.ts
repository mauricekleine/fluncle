// A tiny path-pattern router for the daemon's /api surface. Patterns are plain
// segments plus `:param` captures ("/api/:feature/runs/:runId/stream"); first
// registered match wins. Pure matching — unit-tested without a socket.

export type RouteParams = Record<string, string>;

export type RouteHandler = (req: Request, params: RouteParams) => Promise<Response> | Response;

type Route = {
  handler: RouteHandler;
  method: string;
  segments: string[];
};

export type RouterMatch = {
  handler: RouteHandler;
  params: RouteParams;
};

export type Router = {
  add(method: string, pattern: string, handler: RouteHandler): void;
  match(method: string, pathname: string): RouterMatch | undefined;
};

function matchSegments(segments: string[], parts: string[]): RouteParams | undefined {
  if (segments.length !== parts.length) {
    return undefined;
  }

  const params: RouteParams = {};

  for (let i = 0; i < parts.length; i++) {
    const segment = segments[i];
    const part = parts[i];

    if (segment === undefined || part === undefined) {
      return undefined;
    }

    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(part);
      continue;
    }

    if (segment !== part) {
      return undefined;
    }
  }

  return params;
}

export function createRouter(): Router {
  const routes: Route[] = [];

  return {
    add(method, pattern, handler) {
      routes.push({ handler, method, segments: pattern.split("/").filter(Boolean) });
    },
    match(method, pathname) {
      const parts = pathname.split("/").filter(Boolean);

      for (const route of routes) {
        if (route.method !== method) {
          continue;
        }

        const params = matchSegments(route.segments, parts);

        if (params !== undefined) {
          return { handler: route.handler, params };
        }
      }

      return undefined;
    },
  };
}
