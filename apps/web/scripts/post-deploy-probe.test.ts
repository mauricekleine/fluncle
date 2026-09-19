import { describe, expect, it } from "vitest";
import {
  VECTOR_ENDPOINT_PROBE_TIMEOUT_MS,
  VECTOR_FALLBACK_DEADLINE_MS,
} from "../src/lib/vector-budget";
import {
  applySlowWarning,
  buildTargets,
  checkContent,
  fetchPolicy,
  judge,
  parseArgs,
  promoteTrackParamOps,
  retarget,
  tierOfPath,
  vectorLane,
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

describe("judge — dark-or-served expectation", () => {
  const darkCapable = {
    content: "json",
    darkCode: "replica_unavailable",
    darkStatus: 503,
    kind: "dark-or-served",
  } as const;

  it("passes the documented dark state — the typed fault proves the route resolves", () => {
    const dark = judge(
      darkCapable,
      503,
      "application/json",
      '{"ok":false,"code":"replica_unavailable","message":"The device replica is unavailable."}',
    );
    expect(dark.verdict).toBe("PASS");
    expect(dark.detail).toContain("dark");
  });

  it("passes a lit 2xx exactly like served", () => {
    expect(
      judge(darkCapable, 200, "application/json", '{"url":"libsql://x","token":"t"}').verdict,
    ).toBe("PASS");
  });

  it("fails the dark status without the typed code — a bare gateway 503 is not dark", () => {
    expect(judge(darkCapable, 503, "text/html", "<html>upstream error</html>").verdict).toBe(
      "FAIL",
    );
  });

  it("still fails a dead route or an unexpected error status", () => {
    expect(judge(darkCapable, 404, "text/html", "<html></html>").verdict).toBe("FAIL");
    expect(judge(darkCapable, 500, "application/json", "{}").verdict).toBe("FAIL");
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

describe("the vector-capable lane", () => {
  it("waits longer than the server is allowed to spend on a vector scan", () => {
    // The probe's budget is DERIVED from the fallback deadline, never restated beside it: a
    // client that gave up first would report a failure the server never committed.
    expect(VECTOR_ENDPOINT_PROBE_TIMEOUT_MS).toBeGreaterThan(VECTOR_FALLBACK_DEADLINE_MS);
    expect(fetchPolicy({ vectorCapable: true }).timeoutMs).toBe(VECTOR_ENDPOINT_PROBE_TIMEOUT_MS);
  });

  it("never stacks a second scan on a timeout", () => {
    // libSQL cannot cancel remote work, so a retry does not replace the first scan — it adds one
    // to the database that is already the bottleneck.
    expect(fetchPolicy({ vectorCapable: true }).attempts).toBe(1);
    expect(fetchPolicy({}).attempts).toBeGreaterThan(1);
  });

  it("keeps every ordinary target on the ordinary budget", () => {
    expect(fetchPolicy({}).timeoutMs).toBeLessThan(VECTOR_ENDPOINT_PROBE_TIMEOUT_MS);
  });

  it("marks the vector-capable ops and nothing else", () => {
    const { promoted } = promoteTrackParamOps(buildTargets().skipped, "ABC.1.23");

    expect(promoted.find((target) => target.name === "list_mixable_tracks")?.vectorCapable).toBe(
      true,
    );
    expect(promoted.find((target) => target.name === "list_similar_tracks")?.vectorCapable).toBe(
      true,
    );
    // `get_track` is a plain row read: it must not buy the long budget or leave the fast lane.
    expect(promoted.find((target) => target.name === "get_track")?.vectorCapable).toBeUndefined();
    expect(vectorLane("list_findings")).toEqual({});
  });

  it("puts the worked search examples in the lane too", () => {
    const examples = buildTargets().targets.filter((target) =>
      target.name.startsWith("search example"),
    );

    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((target) => target.vectorCapable === true)).toBe(true);
  });
});

describe("applySlowWarning", () => {
  it("warns on a slow PASS without failing it", () => {
    const warned = applySlowWarning("PASS", "200 served", 9_000);

    expect(warned.verdict).toBe("WARN");
    expect(warned.detail).toContain("slow");
  });

  it("leaves a fast PASS alone", () => {
    expect(applySlowWarning("PASS", "200 served", 400)).toEqual({
      detail: "200 served",
      verdict: "PASS",
    });
  });

  it("never rescues a failure into a warning", () => {
    expect(applySlowWarning("FAIL", "404 (expected 2xx)", 30_000).verdict).toBe("FAIL");
    expect(applySlowWarning("CRIT", "200 (auth gate open)", 30_000).verdict).toBe("CRIT");
  });
});
