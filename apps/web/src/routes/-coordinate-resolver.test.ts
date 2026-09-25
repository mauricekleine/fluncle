import { describe, expect, it } from "vitest";
import { LOG_ID_TEST_VECTORS } from "@fluncle/contracts/log-id";
import { canonicalCoordinate, isLogPageParam } from "@/lib/log-page-param";
import { Route as CoordinateRoute } from "./$coordinate";

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
    expect(canonicalCoordinate("049.7.6b")).toBe("049.7.6B");
    expect(canonicalCoordinate("019.f.1a")).toBe("019.F.1A");

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
    const redirect = captureRedirect("049.7.6b");

    expect(redirect.params).toEqual({ logId: "049.7.6B" });

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
