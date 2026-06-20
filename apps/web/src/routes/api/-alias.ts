// Shared plumbing for the /api/v1 ↔ /api dual-mount. Every API route is served
// canonically under /api/v1/* with the bare /api/* path kept as a permanent
// back-compat alias — the same handler object mounted at both paths (not a
// redirect, so POST bodies for submissions/me survive). The source of truth is
// the /api/* route file, which exports a typed `serverHandlers`; the /api/v1
// mirror re-mounts the very same object.
//
// This file is excluded from the route tree by its `-` prefix (TanStack's
// routeFileIgnorePrefix), so it can be imported by routes without becoming one.

// The context every Fluncle API handler is invoked with. Handlers only ever
// read `request` and `params`, so this is the whole surface they need; typing
// `serverHandlers` against it gives each handler body its parameter types
// without coupling to a route's literal path.
type ApiHandlerContext = {
  params: Record<string, string>;
  request: Request;
};

type ApiHandler = (context: ApiHandlerContext) => Promise<Response> | Response;

export type ApiHandlers = Partial<
  Record<"DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT", ApiHandler>
>;

// TanStack types a route's handler functions by the route's literal path, so
// the same handler object is nominally typed against "/api/x" at one mount and
// "/api/v1/x" at the other — two structurally identical types the compiler
// treats as unrelated. The handlers are genuinely path-agnostic plain
// functions (params/request match because the path segments match), so this
// helper erases only that phantom path coupling, in one documented place,
// rather than scattering casts across every route file.
//
// The real shape is enforced where it matters — at each route's
// `export const serverHandlers: ApiHandlers = { ... }` declaration — so this
// pass-through is deliberately generic: it accepts that object as well as the
// equivalent handlers TanStack has already typed against a route's own path,
// and unbinds the path phantom for the mount site.
export function aliasHandlers<T>(handlers: T): never {
  return handlers as never;
}
