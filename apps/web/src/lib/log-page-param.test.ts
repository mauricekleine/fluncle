import { describe, expect, it } from "vitest";
import { isLogId, isMixtapeLogId } from "./log-id";
import { isLogPageParam } from "./log-page-param";

// The /log/$logId shape guard: the route's beforeLoad 404s anything this
// predicate rejects, BEFORE the loader runs.
describe("isLogPageParam (the /log param guard)", () => {
  it("accepts a Log ID coordinate", () => {
    expect(isLogPageParam("004.7.2I")).toBe(true);
    expect(isLogPageParam("011.6.8K")).toBe(true);
  });

  it("accepts the 4-digit sector the scheme widens to in 2029", () => {
    expect(isLogPageParam("1004.7.2I")).toBe(true);
  });

  it("accepts a well-formed but unknown coordinate (the loader 404s it)", () => {
    expect(isLogPageParam("999.9.9Z")).toBe(true);
  });

  it("accepts a legacy Spotify track id deep link (the loader 301s it)", () => {
    expect(isLogPageParam("6Y44zcYp0vUkmKCBve1Epr")).toBe(true);
  });

  it("accepts a mixtape coordinate with the F marker", () => {
    expect(isMixtapeLogId("019.F.1A")).toBe(true);
    expect(isLogPageParam("019.F.1A")).toBe(true);
    expect(isMixtapeLogId("019.1.1A")).toBe(false);
    expect(isLogId("019.F.1A")).toBe(false);
  });

  it("rejects garbage, paths, and the scheme-prefixed form", () => {
    expect(isLogPageParam("garbage!!")).toBe(false);
    expect(isLogPageParam("fluncle://004.7.2I")).toBe(false);
    expect(isLogPageParam(".well-known")).toBe(false);
    expect(isLogPageParam("004.7.2i")).toBe(false);
    expect(isLogPageParam("004.72I")).toBe(false);
    expect(isLogPageParam("")).toBe(false);
  });

  it("matches the canonical coordinate pattern exactly", () => {
    expect(isLogId("004.7.2I")).toBe(true);
    expect(isLogId("04.7.2I")).toBe(false);
    expect(isLogId("004.7.22I")).toBe(false);
  });
});
