import { describe, expect, it } from "vitest";
import {
  buildTargets,
  checkContent,
  judge,
  parseArgs,
  pathnameOf,
  promoteTrackParamOps,
  retarget,
  tierOfPath,
} from "./post-deploy-probe";

// Unit coverage for the post-deploy probe's PURE derivation + judgement logic. The
// live prod sweep is exercised by running the script; this pins the classification
// so a contract/registry change can't silently mis-tier a surface or a wrong-status
// assertion slip in.

describe("tierOfPath", () => {
  it("classifies admin, private, and the /me public carve-out", () => {
    expect(tierOfPath("/admin/tracks")).toBe("admin");
    expect(tierOfPath("/admin/tracks/{trackId}")).toBe("admin");
    // GET /me returns user-or-null and never 401s — a deliberate public carve-out.
    expect(tierOfPath("/me")).toBe("public");
    expect(tierOfPath("/me/saved-findings")).toBe("private");
    expect(tierOfPath("/me/csrf")).toBe("private");
    expect(tierOfPath("/tracks")).toBe("public");
    expect(tierOfPath("/search/archive")).toBe("public");
  });
});

describe("pathnameOf", () => {
  // The `:param` test must run on the PATH, not the raw URL: every absolute URL
  // contains the scheme's colon, so testing the whole string would skip every
  // surface that carries only a `url` and no `route` — silent drift, the exact
  // failure this probe exists to catch.
  it("excludes the scheme colon so only a real route param reads as parameterised", () => {
    expect(pathnameOf("https://www.fluncle.com/rss.xml")).toBe("/rss.xml");
    expect(pathnameOf("https://www.fluncle.com/rss.xml").includes(":")).toBe(false);
    expect(pathnameOf("https://www.fluncle.com/artist/:slug/fresh.xml").includes(":")).toBe(true);
    expect(pathnameOf("https://galaxy.fluncle.com").includes(":")).toBe(false);
  });

  it("returns an empty path for an unparseable URL", () => {
    expect(pathnameOf("not a url")).toBe("");
  });
});

describe("checkContent", () => {
  it("accepts well-formed bodies per kind", () => {
    expect(checkContent("html", "text/html", "<!doctype html><body>hi</body>")).toBeNull();
    expect(checkContent("html", "application/octet-stream", "<html></html>")).toBeNull();
    expect(checkContent("json", "application/json", '{"ok":true}')).toBeNull();
    expect(checkContent("xml", "application/xml", '<?xml version="1.0"?><rss></rss>')).toBeNull();
    expect(checkContent("text", "text/plain", "User-agent: *")).toBeNull();
  });

  it("rejects malformed or empty bodies", () => {
    expect(checkContent("json", "application/json", "not json")).toBe("unparseable JSON");
    expect(checkContent("xml", "text/html", "<html>error page</html>")).toBeNull(); // starts with < → xml-ish, ok
    expect(checkContent("xml", "text/plain", "Internal Error")).toBe("not XML");
    expect(checkContent("html", "text/plain", "plain text error")).toBe("not HTML");
    expect(checkContent("text", "text/plain", "   ")).toBe("empty body");
  });
});

describe("judge — auth-gate expectation", () => {
  const authGate = { kind: "auth-gate" } as const;

  it("passes on 401/403 (gate held)", () => {
    expect(judge(authGate, 401, "application/json", "{}").verdict).toBe("PASS");
    expect(judge(authGate, 403, "application/json", "{}").verdict).toBe("PASS");
  });

  it("is CRITICAL on a 2xx (auth gate open)", () => {
    expect(judge(authGate, 200, "application/json", "{}").verdict).toBe("CRIT");
  });

  it("treats a 400 as served (input validated before auth), not a leak", () => {
    expect(judge(authGate, 400, "application/json", "{}").verdict).toBe("PASS");
  });

  it("fails on a dead route (404) or a server error", () => {
    expect(judge(authGate, 404, "text/html", "<html></html>").verdict).toBe("FAIL");
    expect(judge(authGate, 500, "text/html", "<html></html>").verdict).toBe("FAIL");
  });
});

describe("judge — served expectation", () => {
  const servedJson = { content: "json", kind: "served" } as const;

  it("passes a parseable 2xx JSON body", () => {
    expect(judge(servedJson, 200, "application/json", '{"tracks":[]}').verdict).toBe("PASS");
  });

  it("fails a 2xx with an unparseable body", () => {
    expect(judge(servedJson, 200, "application/json", "<html>oops</html>").verdict).toBe("FAIL");
  });

  it("passes a 400 as served-with-input-required", () => {
    expect(judge(servedJson, 400, "application/json", '{"error":"q required"}').verdict).toBe(
      "PASS",
    );
  });

  it("fails a 404 / 5xx", () => {
    expect(judge(servedJson, 404, "text/html", "nope").verdict).toBe("FAIL");
    expect(judge(servedJson, 503, "text/html", "down").verdict).toBe("FAIL");
  });
});

describe("retarget", () => {
  const prodWeb = {
    className: "web",
    expect: { content: "html", kind: "served" },
    name: "web.home",
    rewritable: true,
    url: "https://www.fluncle.com/",
  } as const;

  const subdomain = {
    className: "subdomain",
    expect: { content: "html", kind: "served" },
    name: "subdomain.galaxy",
    rewritable: false,
    url: "https://galaxy.fluncle.com",
  } as const;

  it("leaves prod URLs untouched at the default origin", () => {
    expect(retarget(prodWeb, "https://www.fluncle.com")).toEqual({
      crossOrigin: false,
      url: "https://www.fluncle.com/",
    });
  });

  it("swaps a rewritable origin onto a local base", () => {
    expect(retarget(prodWeb, "http://127.0.0.1:3000")).toEqual({
      crossOrigin: false,
      url: "http://127.0.0.1:3000/",
    });
  });

  it("flags a distinct-host subdomain as cross-origin off prod", () => {
    expect(retarget(subdomain, "http://127.0.0.1:3000")).toEqual({
      crossOrigin: true,
      url: "https://galaxy.fluncle.com",
    });
  });
});

describe("parseArgs", () => {
  it("defaults to prod", () => {
    expect(parseArgs([])).toEqual({ baseUrl: "https://www.fluncle.com", json: false });
  });

  it("reads --base-url (space and = forms) and strips a trailing slash", () => {
    expect(parseArgs(["--base-url", "http://127.0.0.1:3000/"]).baseUrl).toBe(
      "http://127.0.0.1:3000",
    );
    expect(parseArgs(["--base-url=http://localhost:8787"]).baseUrl).toBe("http://localhost:8787");
  });

  it("reads --json", () => {
    expect(parseArgs(["--json"]).json).toBe(true);
  });
});

describe("buildTargets — derivation invariants", () => {
  const { targets, skipped } = buildTargets();

  it("fires only GET targets with fully-resolved absolute URLs (no unbound params)", () => {
    expect(targets.length).toBeGreaterThan(20);
    for (const target of targets) {
      expect(target.url).toMatch(/^https?:\/\//);
      expect(target.url).not.toContain("{");
    }
  });

  it("covers the health endpoint as a public served-JSON read", () => {
    const health = targets.find((target) => target.name === "get_health");
    expect(health).toBeDefined();
    expect(health?.className).toBe("api-public");
    expect(health?.expect).toEqual({ content: "json", kind: "served" });
    expect(health?.url).toBe("https://www.fluncle.com/api/v1/health");
  });

  it("probes an admin op unauthenticated with the auth-gate expectation", () => {
    const adminList = targets.find((target) => target.name === "list_tracks_admin");
    expect(adminList?.className).toBe("api-auth");
    expect(adminList?.expect).toEqual({ kind: "auth-gate" });
    expect(adminList?.url).toContain("/api/v1/admin/tracks");
  });

  it("substitutes an inert placeholder into an auth-gated parametric path", () => {
    const adminParam = targets.find((target) => target.name === "get_track_admin");
    expect(adminParam?.className).toBe("api-auth");
    expect(adminParam?.url).toContain("/admin/tracks/probe");
  });

  it("catalogues write ops as skipped and never as fired targets", () => {
    const submit = skipped.find((skip) => skip.name === "submit_track");
    expect(submit?.className).toBe("api-write");
    expect(targets.some((target) => target.name === "submit_track")).toBe(false);
  });

  it("skips public parametric reads and the object-store / onion subdomains", () => {
    expect(
      skipped.some((skip) => skip.name === "get_track" && skip.className === "api-public"),
    ).toBe(true);
    expect(skipped.some((skip) => skip.name === "subdomain.found")).toBe(true);
    expect(skipped.some((skip) => skip.name === "subdomain.onion")).toBe(true);
  });
});

describe("promoteTrackParamOps", () => {
  const { skipped } = buildTargets();

  it("promotes the track-id family when a sample Log ID is available", () => {
    const { promoted, remaining } = promoteTrackParamOps(skipped, "ABC.1.23");
    const getTrack = promoted.find((target) => target.name === "get_track");
    expect(getTrack).toBeDefined();
    expect(getTrack?.url).toBe("https://www.fluncle.com/api/v1/tracks/ABC.1.23");
    expect(getTrack?.expect).toEqual({ content: "json", kind: "served" });
    // A slug-keyed public read is NOT a track-id op, so it stays skipped.
    expect(remaining.some((skip) => skip.name === "get_artist")).toBe(true);
    expect(promoted.some((target) => target.name === "get_artist")).toBe(false);
  });

  it("promotes nothing when there is no sample id (honest degradation)", () => {
    const { promoted, remaining } = promoteTrackParamOps(skipped, null);
    expect(promoted).toHaveLength(0);
    expect(remaining).toEqual(skipped);
  });
});
