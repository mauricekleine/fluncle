// THE CORS LINE, pinned from both sides.
//
// A permissive `Access-Control-Allow-Origin` is the kind of header that is correct until one day it
// is catastrophic, and the failure is silent: nothing breaks, a door just opens somewhere nobody
// looked. So this suite asserts the line rather than the feature — that the public reads are on the
// open side, and that every admin op, every authenticated op, every write, and the two deliberate
// exclusions are on the closed side.
//
// The classification is DERIVED from the composed router (see ./orpc-cors), so these assertions run
// against the real thing rather than a copy of it: an op that gains or loses auth middleware moves
// across this line by itself, and the exhaustive assertion below catches it.

import { describe, expect, it } from "vitest";
import { isPublicCorsPath } from "./orpc";
import { router } from "./orpc";
import { adminAuth, operatorGuard, privateUserAuth } from "./orpc-auth";

/** The auth middleware singletons, by reference — the same handles the auth-tier net reads. */
const AUTH_MIDDLEWARE = new Set<unknown>([adminAuth, operatorGuard, privateUserAuth]);

type RouterOp = {
  "~orpc"?: { middlewares?: unknown[]; route?: { method?: string; path?: string } };
};

function opsOf(): Array<{ method: string; middlewares: unknown[]; name: string; path: string }> {
  return Object.entries(router as unknown as Record<string, unknown>).flatMap(([name, op]) => {
    const meta = (op as RouterOp)["~orpc"];
    const path = meta?.route?.path;

    return path === undefined
      ? []
      : [
          {
            method: meta?.route?.method ?? "GET",
            middlewares: meta?.middlewares ?? [],
            name,
            path,
          },
        ];
  });
}

/** A concrete request path off a route template: every `{param}` filled with a plausible segment. */
function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/g, "sample");
}

describe("what may answer a browser from another origin", () => {
  it("opens the anonymous public reads", () => {
    // A spread of the surface a refugee integrator actually calls, including the identity door this
    // whole slice exists for.
    for (const path of [
      "/tracks/GBABC1234567",
      "/tracks",
      "/findings",
      "/artists/calibre",
      "/albums/shelflife",
      "/labels/signature",
      "/search",
      "/health",
      "/mixtapes",
    ]) {
      expect(isPublicCorsPath(path), path).toBe(true);
    }
  });

  it("closes every admin op", () => {
    const admin = opsOf().filter((op) => op.path.startsWith("/admin"));

    // Guard the guard: an empty list would make the assertion below vacuously true.
    expect(admin.length).toBeGreaterThan(20);

    for (const op of admin) {
      expect(isPublicCorsPath(concretePath(op.path)), op.name).toBe(false);
    }
  });

  it("closes every op that carries auth middleware, whatever its path", () => {
    const authed = opsOf().filter((op) =>
      op.middlewares.some((middleware) => AUTH_MIDDLEWARE.has(middleware)),
    );

    expect(authed.length).toBeGreaterThan(0);

    for (const op of authed) {
      expect(isPublicCorsPath(concretePath(op.path)), op.name).toBe(false);
    }
  });

  it("closes the two deliberate exclusions", () => {
    // The replica credential mint: no auth middleware (the device proves itself in the body), but
    // handing a credential-minting read to arbitrary origins is the one thing it must not do.
    expect(isPublicCorsPath("/replica/token")).toBe(false);
    // The signed-in user's own door. Under `*` no cookie ever rides, so a cross-origin caller would
    // get a confident permanent `null` — a wrong answer dressed as a real one.
    expect(isPublicCorsPath("/me")).toBe(false);

    // And both are still real ops, so a rename cannot leave a dead exclusion behind and quietly
    // reopen the door.
    const names = new Set(opsOf().map((op) => op.name));

    expect(names.has("get_replica_token")).toBe(true);
    expect(names.has("get_current_private_user")).toBe(true);
  });

  it("does not open a path it was never given", () => {
    // A parameter matches ONE segment, so a sub-resource under a public read is judged on its own
    // op rather than inheriting its parent's allowance.
    expect(isPublicCorsPath("/tracks/GBABC1234567/extra/deeper")).toBe(false);
    expect(isPublicCorsPath("/nope")).toBe(false);
    expect(isPublicCorsPath("")).toBe(false);
  });
});

describe("the headers on the wire", () => {
  it("answers the preflight for a public read and stamps the allowance on the read itself", async () => {
    const { handleOrpc } = await import("./orpc");
    const preflight = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/tracks/-", {
        headers: { "access-control-request-method": "GET", origin: "https://example.com" },
        method: "OPTIONS",
      }),
    );

    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight?.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight?.headers.get("access-control-max-age")).toBeTruthy();
    // The allowance is a literal `*` for every caller, so the response does not vary by origin and
    // must not claim to — a `Vary: Origin` here would fragment every cache in front of the surface.
    expect(preflight?.headers.get("vary")).toBeNull();
  });

  it("sends no allowance for an admin preflight, so the browser blocks the real request", async () => {
    const { handleOrpc } = await import("./orpc");
    const preflight = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/tracks", {
        headers: { "access-control-request-method": "GET", origin: "https://example.com" },
        method: "OPTIONS",
      }),
    );

    // Falls through the oRPC seam entirely (no procedure matches an OPTIONS), which is the correct
    // outcome: no header, so the browser refuses to send the request it was asking about.
    expect(preflight?.headers.get("access-control-allow-origin") ?? null).toBeNull();
  });
});
