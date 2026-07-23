import { describe, expect, it } from "vitest";

import {
  computeFusedPlatforms,
  interpretStatus,
  type PlatformTally,
  RELIABLE,
  REMOVABLE,
} from "./probe-artist-socials-liveness";

// PURE coverage for the liveness probe's verdict + safety logic. The live HTTP probing
// is exercised by running the script; this pins the cert-trap lesson: arbitrary-domain
// oracles (homepage/bandcamp) are REPORT-only, and a neterr there is host-dead, never
// an auto-removal.

describe("interpretStatus — valid-cert honest oracles (soundcloud/mixcloud/youtube)", () => {
  for (const p of ["soundcloud", "mixcloud", "youtube"]) {
    it(`${p}: 200→live, 404→dead, other→unknown, neterr→unknown`, () => {
      expect(interpretStatus(p, 200)).toBe("live");
      expect(interpretStatus(p, 404)).toBe("dead");
      expect(interpretStatus(p, 403)).toBe("unknown");
      expect(interpretStatus(p, 500)).toBe("unknown");
      expect(interpretStatus(p, "neterr")).toBe("unknown");
    });
  }
});

describe("interpretStatus — arbitrary-domain oracles (homepage/bandcamp)", () => {
  for (const p of ["homepage", "bandcamp"]) {
    it(`${p}: <400→live, 404/410→dead, neterr→host-dead (cert/timeout), 403→unknown`, () => {
      expect(interpretStatus(p, 200)).toBe("live");
      expect(interpretStatus(p, 301)).toBe("live");
      expect(interpretStatus(p, 404)).toBe("dead");
      expect(interpretStatus(p, 410)).toBe("dead");
      expect(interpretStatus(p, "neterr")).toBe("host-dead");
      expect(interpretStatus(p, 403)).toBe("unknown");
    });
  }
});

describe("interpretStatus — soft platforms are never a verdict", () => {
  for (const p of ["instagram", "tiktok", "facebook", "twitter", "beatport", "twitch"]) {
    it(`${p} is always unknown`, () => {
      expect(interpretStatus(p, 200)).toBe("unknown");
      expect(interpretStatus(p, 404)).toBe("unknown");
      expect(interpretStatus(p, "neterr")).toBe("unknown");
    });
  }
});

describe("RELIABLE vs REMOVABLE — arbitrary-domain oracles report but never auto-remove", () => {
  it("soundcloud/mixcloud/youtube are removable", () => {
    for (const p of ["soundcloud", "mixcloud", "youtube"]) {
      expect(RELIABLE.has(p)).toBe(true);
      expect(REMOVABLE.has(p)).toBe(true);
    }
  });
  it("homepage/bandcamp are reliable-to-report but NOT removable", () => {
    for (const p of ["homepage", "bandcamp"]) {
      expect(RELIABLE.has(p)).toBe(true);
      expect(REMOVABLE.has(p)).toBe(false);
    }
  });
  it("soft platforms are neither", () => {
    expect(RELIABLE.has("instagram")).toBe(false);
    expect(REMOVABLE.has("tiktok")).toBe(false);
  });
});

describe("computeFusedPlatforms — a suspect oracle removes nothing", () => {
  const tally = (live: number, dead: number, unknown: number): PlatformTally => ({
    dead,
    live,
    total: live + dead + unknown,
    unknown,
  });

  it("fuses a reliable platform above 25% dead", () => {
    const per = new Map([["soundcloud", tally(50, 40, 10)]]); // 40% dead
    expect(computeFusedPlatforms(per).has("soundcloud")).toBe(true);
  });
  it("does not fuse under the threshold", () => {
    const per = new Map([["youtube", tally(90, 5, 5)]]); // 5% dead
    expect(computeFusedPlatforms(per).has("youtube")).toBe(false);
  });
  it("never fuses a soft platform", () => {
    const per = new Map([["instagram", tally(0, 0, 100)]]);
    expect(computeFusedPlatforms(per).has("instagram")).toBe(false);
  });
});
