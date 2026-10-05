import { describe, expect, it } from "vitest";
import { runWithDatabaseRequestScope } from "./database-request-scope";
import { noteTransientDatabaseFailure } from "./db";
import { withTransientDatabaseFailure } from "./transient-failure";

describe("withTransientDatabaseFailure", () => {
  it.each([
    ["/track/mb_x", "GET", 500],
    ["/sitemap.xml", "GET", 502],
    ["/sitemap/tracks-1.xml", "GET", 504],
    ["/", "GET", 500],
    ["/tracks?galaxy=drift", "GET", 500],
    ["/track/mb_x", "HEAD", 500],
  ] as const)(
    "rewrites %s %s errors with status %s and preserves the body and headers",
    async (path, method, status) => {
      const response = runWithDatabaseRequestScope(() => {
        noteTransientDatabaseFailure();
        return withTransientDatabaseFailure(
          new Request(`https://www.fluncle.com${path}`, { method }),
          new Response("render error", {
            headers: { "Cache-Control": "public", "content-type": "text/html", "x-test": "kept" },
            status,
          }),
        );
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/html");
      expect(response.headers.get("x-test")).toBe("kept");
      expect(await response.text()).toBe("render error");
    },
  );

  it.each([
    ["/track/mb_x", "GET", 500, false],
    ["/track/mb_x", "GET", 404, true],
    ["/track/mb_x", "GET", 200, true],
    ["/track/mb_x", "GET", 503, true],
    ["/track/mb_x", "POST", 500, true],
    ["/_serverFn/abc", "GET", 500, true],
    ["/api/v1/tracks", "GET", 500, true],
    ["/mcp", "GET", 500, true],
    ["/admin/tracks", "GET", 500, true],
  ] as const)("leaves %s %s status %s unchanged with marker %s", (path, method, status, marked) => {
    runWithDatabaseRequestScope(() => {
      if (marked) {
        noteTransientDatabaseFailure();
      }
      const response = new Response("original", { status });
      expect(
        withTransientDatabaseFailure(
          new Request(`https://www.fluncle.com${path}`, { method }),
          response,
        ),
      ).toBe(response);
    });
  });
});
