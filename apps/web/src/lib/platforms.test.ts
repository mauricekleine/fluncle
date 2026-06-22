import { describe, expect, it } from "vitest";
import { PLATFORMS as PLATFORM_CONFIGS } from "@/components/admin/platform-cell";
import { type Platform, isPlatform, PLATFORM_KEYS, PLATFORMS } from "./platforms";

// Coverage guard: every `Platform` must be fully wired across the runtime maps
// that should cover ALL push targets. A new platform added to PLATFORMS without
// its icon / label / membership entry fails one of these — the build-fail intent.
// (The per-platform PUSH dispatch is guarded separately, at compile time, by the
// exhaustive `switch (platform)` + `never` default in the draft route.)

describe("platform coverage", () => {
  it("derives the keys from PLATFORMS", () => {
    expect(PLATFORM_KEYS).toEqual(PLATFORMS.map((platform) => platform.key));
  });

  it("recognises every platform key and rejects others", () => {
    for (const key of PLATFORM_KEYS) {
      expect(isPlatform(key)).toBe(true);
    }

    expect(isPlatform("instagram")).toBe(false);
    expect(isPlatform("")).toBe(false);
  });

  it("gives every platform a non-empty label", () => {
    for (const platform of PLATFORMS) {
      expect(platform.label.length).toBeGreaterThan(0);
    }
  });

  it("attaches a brand icon to every platform (the admin PLATFORMS config)", () => {
    // platform-cell.PLATFORMS joins each platform to its icon via a
    // `Record<Platform, Icon>`; assert the join covered every key, with no extras.
    const configured = new Set(PLATFORM_CONFIGS.map((config) => config.key));

    expect(configured).toEqual(new Set(PLATFORM_KEYS));

    for (const config of PLATFORM_CONFIGS) {
      expect(config.Icon).toBeTypeOf("function");
    }
  });

  it("keeps the exhaustive coverage map in lock-step with Platform", () => {
    // A type-level exhaustiveness gate: this Record<Platform, true> stops
    // type-checking the moment a `Platform` is added without an entry here, so a
    // forgotten platform is a build failure, not a silent runtime gap.
    const covered: Record<Platform, true> = {
      tiktok: true,
      youtube: true,
    };

    for (const key of PLATFORM_KEYS) {
      expect(covered[key]).toBe(true);
    }
  });
});
