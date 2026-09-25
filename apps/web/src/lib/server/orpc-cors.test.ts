import { describe, expect, it } from "vitest";
import { isPublicCorsPath } from "./orpc";
import { router } from "./orpc";
import { adminAuth, operatorGuard, privateUserAuth } from "./orpc-auth";

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

function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/g, "sample");
}

describe("what may answer a browser from another origin", () => {
  it("opens the anonymous public reads", () => {
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
    expect(isPublicCorsPath("/replica/token")).toBe(false);

    expect(isPublicCorsPath("/me")).toBe(false);

    const names = new Set(opsOf().map((op) => op.name));

    expect(names.has("get_replica_token")).toBe(true);
    expect(names.has("get_current_private_user")).toBe(true);
  });

  it("does not open a path it was never given", () => {
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

    expect(preflight?.headers.get("access-control-allow-origin") ?? null).toBeNull();
  });
});
