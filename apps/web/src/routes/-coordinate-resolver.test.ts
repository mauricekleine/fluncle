import { describe, expect, it } from "vitest";
import { LOG_ID_TEST_VECTORS } from "@fluncle/contracts/log-id";
import { canonicalCoordinate, isLogPageParam } from "@/lib/log-page-param";
import { Route as CoordinateRoute } from "./$coordinate";

// The bare-coordinate resolver: `fluncle.com/049.7.6B` → 301 `/log/049.7.6B`. Only the
// finding + mixtape coordinate grammar resolves (uppercased first, so a viewer's
// lowercase typing still lands); anything else throws notFound() and falls through to
// the site-wide 404. Captions keep `fluncle://<coord>` — this route serves the viewer
// who types what they see in the frame.

type ThrownRedirect = {
  options?: { params?: unknown; statusCode?: number; to?: string };
  params?: unknown;
  statusCode?: number;
  to?: string;
};

function runBeforeLoad(coordinate: string): unknown {
  return CoordinateRoute.options.beforeLoad?.({ params: { coordinate } } as never);
}

function captureThrow(run: () => unknown): { redirect?: ThrownRedirect; notFound?: boolean } {
  try {
    run();
  } catch (thrown) {
    // beforeLoad throws exactly two shapes: a redirect (carries a `to` target, on the
    // object or under `.options`) or a `notFound()` (has neither). Detect by the target
    // rather than an internal flag name, so the check survives a router-internal rename.
    const value = thrown as ThrownRedirect;
    const target = value.to ?? value.options?.to;

    return target ? { redirect: value } : { notFound: true };
  }

  throw new Error("expected beforeLoad to throw (a redirect or notFound)");
}

function captureRedirect(coordinate: string): {
  params?: unknown;
  statusCode?: number;
  to?: string;
} {
  const { redirect, notFound } = captureThrow(() => runBeforeLoad(coordinate));

  if (notFound || !redirect) {
    throw new Error(`expected a redirect for "${coordinate}", got notFound`);
  }

  const source = redirect.options ?? redirect;

  return { params: source.params, statusCode: source.statusCode, to: source.to };
}

describe("canonicalCoordinate", () => {
  it("accepts every well-formed finding coordinate, canonical-cased", () => {
    for (const logId of LOG_ID_TEST_VECTORS.validFindings) {
      expect(canonicalCoordinate(logId)).toBe(logId);
    }
  });

  it("accepts every well-formed mixtape coordinate, canonical-cased", () => {
    for (const logId of LOG_ID_TEST_VECTORS.validMixtapes) {
      expect(canonicalCoordinate(logId)).toBe(logId);
    }
  });

  it("uppercases a lowercase-typed coordinate to its canonical form", () => {
    // The frame reads `049.7.6B`; a viewer may type `049.7.6b`. Both must resolve.
    expect(canonicalCoordinate("049.7.6b")).toBe("049.7.6B");
    expect(canonicalCoordinate("019.f.1a")).toBe("019.F.1A");
    // The shared lowercase vectors (which the case-SENSITIVE bare guards reject) resolve
    // here precisely because this guard uppercases first.
    for (const lower of LOG_ID_TEST_VECTORS.lowercase) {
      expect(canonicalCoordinate(lower)).toBe(lower.toUpperCase());
    }
  });

  it("rejects every structurally-malformed coordinate", () => {
    for (const bad of LOG_ID_TEST_VECTORS.malformed) {
      expect(canonicalCoordinate(bad)).toBeUndefined();
    }
  });

  it("rejects a bare Spotify track id (uppercasing would corrupt it)", () => {
    // A 22-char base-62 id IS a valid /log param, but never a root coordinate.
    const spotifyId = "6Y44zcYp0vUkmKCBve1Epr";
    expect(isLogPageParam(spotifyId)).toBe(true);
    expect(canonicalCoordinate(spotifyId)).toBeUndefined();
  });

  it("rejects arbitrary single segments (real routes / unknown paths)", () => {
    for (const value of ["about", "log", "artists", "foobar", "", "049"]) {
      expect(canonicalCoordinate(value)).toBeUndefined();
    }
  });
});

describe("/$coordinate → /log/$logId", () => {
  it("301s a finding coordinate to its /log home", () => {
    const redirect = captureRedirect("049.7.6B");

    expect(redirect.to).toBe("/log/$logId");
    expect(redirect.statusCode).toBe(301);
    expect(redirect.params).toEqual({ logId: "049.7.6B" });
  });

  it("301s a lowercase-typed coordinate to the CANONICAL uppercased /log home", () => {
    // Without the uppercase, /log's case-sensitive guard would 404 the forwarded param.
    const redirect = captureRedirect("049.7.6b");

    expect(redirect.params).toEqual({ logId: "049.7.6B" });
    // The forwarded param is admitted by /log's own guard with no further hop.
    expect(isLogPageParam((redirect.params as { logId: string }).logId)).toBe(true);
  });

  it("301s a mixtape F-coordinate too (the grammar the guard accepts)", () => {
    const redirect = captureRedirect("019.f.1a");

    expect(redirect.to).toBe("/log/$logId");
    expect(redirect.params).toEqual({ logId: "019.F.1A" });
  });

  it("throws notFound() for a non-coordinate segment (falls through to the site 404)", () => {
    for (const value of ["foobar", "about", "6Y44zcYp0vUkmKCBve1Epr"]) {
      const { notFound } = captureThrow(() => runBeforeLoad(value));
      expect(notFound).toBe(true);
    }
  });
});
