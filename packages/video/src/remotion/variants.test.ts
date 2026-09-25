import assert from "node:assert/strict";

import { describe, expect, test } from "bun:test";

import {
  buildVariants,
  FOOTAGE_FILENAME,
  FOOTAGE_LANDSCAPE_FILENAME,
  FOOTAGE_LANDSCAPE_SOCIAL_FILENAME,
  FOOTAGE_NOTEXT_FILENAME,
  FOOTAGE_SOCIAL_FILENAME,
} from "./variants";

const both = buildVariants();
assert.deepEqual(both, {
  [FOOTAGE_FILENAME]: { aspect: "square", hideOverlay: true },
  [FOOTAGE_SOCIAL_FILENAME]: { aspect: "portrait", hideOverlay: false },
});

assert.equal(both[FOOTAGE_FILENAME].aspect, "square");
assert.equal(both[FOOTAGE_FILENAME].hideOverlay, true);

assert.equal(both[FOOTAGE_SOCIAL_FILENAME].aspect, "portrait");
assert.equal(both[FOOTAGE_SOCIAL_FILENAME].hideOverlay, false);

const onlySquare = buildVariants({ footageSocial: false });
assert.deepEqual(onlySquare, {
  [FOOTAGE_FILENAME]: { aspect: "square", hideOverlay: true },
});

const onlySocial = buildVariants({ footage: false });
assert.deepEqual(onlySocial, {
  [FOOTAGE_SOCIAL_FILENAME]: { aspect: "portrait", hideOverlay: false },
});

console.log("variants.test.ts OK");

describe("buildVariants — extra variants", () => {
  test("default off: no extra entries beyond the two masters", () => {
    const variants = buildVariants();

    expect(Object.keys(variants)).toEqual([FOOTAGE_FILENAME, FOOTAGE_SOCIAL_FILENAME]);
  });

  test("footageLandscape adds the clean landscape escape hatch", () => {
    const variants = buildVariants({ footageLandscape: true });

    expect(variants[FOOTAGE_LANDSCAPE_FILENAME]).toEqual({
      aspect: "landscape",
      hideOverlay: true,
    });
  });

  test("footageLandscapeSocial adds the baked-text landscape cut", () => {
    const variants = buildVariants({ footageLandscapeSocial: true });

    expect(variants[FOOTAGE_LANDSCAPE_SOCIAL_FILENAME]).toEqual({
      aspect: "landscape",
      hideOverlay: false,
    });
  });

  test("footageNotext adds the clean portrait cut", () => {
    const variants = buildVariants({ footageNotext: true });

    expect(variants[FOOTAGE_NOTEXT_FILENAME]).toEqual({
      aspect: "portrait",
      hideOverlay: true,
    });
  });

  test("all five together produce a fully-keyed map", () => {
    const variants = buildVariants({
      footageLandscape: true,
      footageLandscapeSocial: true,
      footageNotext: true,
    });

    expect(Object.keys(variants).sort()).toEqual(
      [
        FOOTAGE_FILENAME,
        FOOTAGE_SOCIAL_FILENAME,
        FOOTAGE_LANDSCAPE_FILENAME,
        FOOTAGE_LANDSCAPE_SOCIAL_FILENAME,
        FOOTAGE_NOTEXT_FILENAME,
      ].sort(),
    );
  });
});
