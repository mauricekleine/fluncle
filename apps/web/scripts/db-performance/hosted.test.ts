import { describe, expect, it, vi } from "vitest";

import { HOSTED_SCRATCH_TOKEN_ENV, HOSTED_SCRATCH_URL_ENV, resolveHostedReplay } from "./hosted";

describe("hosted Turso replay gate", () => {
  it("does not read hosted credentials in normal local or CI mode", () => {
    const readEnvironment = vi.fn(() => {
      throw new Error("credentials were read");
    });

    expect(
      resolveHostedReplay({ hosted: false, operatorApproved: false, readEnvironment }),
    ).toEqual({ mode: "local" });
    expect(readEnvironment).not.toHaveBeenCalled();
  });

  it("requires the hosted flag and separate approval before reading credentials", () => {
    const readEnvironment = vi.fn(() => "unused");

    expect(() =>
      resolveHostedReplay({ hosted: false, operatorApproved: true, readEnvironment }),
    ).toThrow("inert without the explicit --hosted flag");
    expect(() =>
      resolveHostedReplay({ hosted: true, operatorApproved: false, readEnvironment }),
    ).toThrow("requires explicit operator approval");
    expect(readEnvironment).not.toHaveBeenCalled();
  });

  it("requires both scratch fields after the two gates", () => {
    const readEnvironment = vi.fn((name: string) =>
      name === HOSTED_SCRATCH_URL_ENV ? "libsql://scale-scratch.example.invalid" : undefined,
    );

    expect(() =>
      resolveHostedReplay({
        hosted: true,
        operatorApproved: true,
        preseededFixture: true,
        readEnvironment,
      }),
    ).toThrow("requires an explicit scratch URL and token");
    expect(readEnvironment).toHaveBeenCalledWith(HOSTED_SCRATCH_URL_ENV);
    expect(readEnvironment).toHaveBeenCalledWith(HOSTED_SCRATCH_TOKEN_ENV);
  });

  it.each([
    "file:local.db",
    "https://localhost",
    "libsql://production.example.invalid",
    "libsql://catalogue-prod.example.invalid",
    "libsql://fluncle.example.invalid",
    "libsql://catalogue-dev.example.invalid",
    "libsql://catalogue-local.example.invalid",
  ])("rejects an obvious non-scratch target without network: %s", (url) => {
    const readEnvironment = (name: string) =>
      name === HOSTED_SCRATCH_URL_ENV ? url : "synthetic-token-value";

    expect(() =>
      resolveHostedReplay({
        hosted: true,
        operatorApproved: true,
        preseededFixture: true,
        readEnvironment,
      }),
    ).toThrow();
  });

  it("accepts a deliberately named scratch URL without constructing a client", () => {
    const readEnvironment = (name: string) =>
      name === HOSTED_SCRATCH_URL_ENV
        ? "libsql://scale-scratch.example.invalid"
        : "synthetic-token-value";

    expect(
      resolveHostedReplay({
        hosted: true,
        operatorApproved: true,
        preseededFixture: true,
        readEnvironment,
      }),
    ).toEqual({
      mode: "hosted",
      token: "synthetic-token-value",
      url: "libsql://scale-scratch.example.invalid",
    });
  });

  it("rejects non-preseeded or full-fixture hosted modes before reading credentials", () => {
    const readEnvironment = vi.fn(() => {
      throw new Error("credentials were read");
    });

    expect(() =>
      resolveHostedReplay({ hosted: true, operatorApproved: true, readEnvironment }),
    ).toThrow("requires --preseeded-fixture");
    expect(() =>
      resolveHostedReplay({
        fullFixture: true,
        hosted: true,
        operatorApproved: true,
        preseededFixture: true,
        readEnvironment,
      }),
    ).toThrow("cannot combine with --full-fixture");
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});
