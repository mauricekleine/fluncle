import { describe, expect, it } from "vitest";

import {
  OBSERVATION_ECHO_DEFAULTS,
  observationEchoError,
  scoreObservationEcho,
} from "./observation-echo";

describe("scoreObservationEcho", () => {
  it("scores an empty neighbourhood as no echo", () => {
    const echo = scoreObservationEcho("The bass walked in on its own two feet.", []);

    expect(echo.echoes).toBe(false);
    expect(echo.overlap).toBe(0);
    expect(echo.logId).toBeNull();
  });

  it("catches a lifted phrase across two scripts (the cross-script verbatim the audit flagged)", () => {
    // The 2026-07-14 audit's worst verbatim: "my shoulders went before i'd clocked the
    // coordinate" surviving in two scripts. An 8-word run clears the 4-word phrase threshold.
    const candidate =
      "My shoulders went before I'd clocked the coordinate on this one, pure rolling menace.";
    const neighbor = {
      logId: "024.7.3Y",
      script: "My shoulders went before I'd clocked the coordinate, and it just kept building.",
    };

    const echo = scoreObservationEcho(candidate, [neighbor]);

    expect(echo.echoes).toBe(true);
    expect(echo.logId).toBe("024.7.3Y");
    expect(echo.phrase).toContain("shoulders went before");
  });

  it("catches wholesale word reuse even when the phrasing is reshuffled", () => {
    const candidate =
      "menace rolling coordinate shoulders drop weather patient tidal halogen coiled";
    const neighbor = {
      logId: "012.1.0A",
      script: "coiled halogen tidal patient weather drop shoulders coordinate rolling menace here",
    };

    const echo = scoreObservationEcho(candidate, [neighbor], {
      maxOverlap: 0.5,
      minPhraseWords: 4,
    });

    expect(echo.echoes).toBe(true);
    expect(echo.overlap).toBeGreaterThan(0.5);
  });

  it("lets an honestly-different read through", () => {
    const candidate =
      "The kick lands like a door closing in a room three floors up. Junglist, tune in.";
    const neighbor = {
      logId: "003.2.1M",
      script: "This one hums low and patient, a tide coming in under the floorboards. Fam.",
    };

    const echo = scoreObservationEcho(candidate, [neighbor]);

    expect(echo.echoes).toBe(false);
  });

  it("reports the WORST neighbour (a lift outranks a bare overlap)", () => {
    const candidate = "the drop landed sideways and my chest went with it, coiled and humid";
    const overlapOnly = { logId: "A", script: "coiled humid chest drop landed sideways went with" };
    const lifted = {
      logId: "B",
      script: "somewhere else the drop landed sideways and nothing else matched",
    };

    const echo = scoreObservationEcho(candidate, [overlapOnly, lifted]);

    expect(echo.echoes).toBe(true);
    expect(echo.logId).toBe("B");
    expect(echo.phrase).toContain("the drop landed sideways");
  });

  it("carries the calibrated defaults", () => {
    expect(OBSERVATION_ECHO_DEFAULTS.maxOverlap).toBe(0.3);
    expect(OBSERVATION_ECHO_DEFAULTS.minPhraseWords).toBe(4);
  });
});

describe("observationEchoError", () => {
  it("names the lifted phrase and the neighbour (so the sweep can route around it)", () => {
    const error = observationEchoError({
      echoes: true,
      logId: "024.7.3Y",
      overlap: 0.4,
      phrase: "my shoulders went before",
      script: "…",
    });

    expect(error.status).toBe(422);
    expect(error.code).toBe("observation_echoes_neighbours");
    expect(error.message).toContain("my shoulders went before");
    expect(error.message).toContain("024.7.3Y");
  });

  it("names the overlap when there is no lifted phrase", () => {
    const error = observationEchoError({
      echoes: true,
      logId: "012.1.0A",
      overlap: 0.55,
      phrase: "",
      script: "…",
    });

    expect(error.message).toContain("55%");
    expect(error.message).toContain("012.1.0A");
  });
});
