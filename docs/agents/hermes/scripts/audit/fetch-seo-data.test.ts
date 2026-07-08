#!/usr/bin/env bun
// Tests for the pure parts of the SEO fetch helper (the network I/O isn't unit-tested — it needs
// live creds; these cover the date window, the JWT assembly + signature, and the normalizers).
// Run: bun test docs/agents/hermes/scripts/audit/fetch-seo-data.test.ts
import { describe, expect, it } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { b64url, buildJwt, normalizeBing, normalizeGscRows, searchWindow } from "./fetch-seo-data";

describe("searchWindow", () => {
  it("is a 28-day window ending 3 days back, UTC YYYY-MM-DD", () => {
    const w = searchWindow(new Date("2026-07-08T12:00:00Z"));
    expect(w.endDate).toBe("2026-07-05"); // 3 days back
    expect(w.startDate).toBe("2026-06-07"); // 28 days before end
  });
});

describe("b64url", () => {
  it("emits url-safe base64 with no padding", () => {
    const out = b64url("sure.");
    expect(out).not.toContain("=");
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
  });
});

describe("buildJwt", () => {
  it("produces a 3-part RS256 JWT whose signature verifies with the SA public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const now = new Date("2026-07-08T00:00:00Z");
    const jwt = buildJwt({ client_email: "sa@fluncle.iam", private_key: pem }, now);

    const [h, c, sig] = jwt.split(".");
    expect(h && c && sig).toBeTruthy();

    // Header + claim decode to the expected shape.
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claim = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claim.iss).toBe("sa@fluncle.iam");
    expect(claim.scope).toContain("webmasters.readonly");
    expect(claim.exp - claim.iat).toBe(3600);

    // The signature verifies over `header.claim` with the matching public key.
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("normalizeGscRows", () => {
  it("flattens rows to {<key>, clicks, impressions, ctr%, position}", () => {
    const out = normalizeGscRows(
      [{ clicks: 3, ctr: 0.25, impressions: 12, keys: ["drum and bass"], position: 4.37 }],
      "query",
    );
    expect(out[0]).toEqual({
      clicks: 3,
      ctr: 25,
      impressions: 12,
      position: 4.4,
      query: "drum and bass",
    });
  });

  it("tolerates missing fields", () => {
    const out = normalizeGscRows([{ keys: ["x"] }], "page");
    expect(out[0]).toEqual({ clicks: 0, ctr: 0, impressions: 0, page: "x", position: 0 });
  });
});

describe("normalizeBing", () => {
  it("maps Bing PascalCase rows to compact records", () => {
    const out = normalizeBing([{ Clicks: 2, Impressions: 40, Query: "netsky" }], "Query");
    expect(out[0]).toEqual({ clicks: 2, impressions: 40, query: "netsky" });
  });

  it("returns [] for undefined input", () => {
    expect(normalizeBing(undefined, "Query")).toEqual([]);
  });
});
