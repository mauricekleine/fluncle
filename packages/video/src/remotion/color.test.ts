import assert from "node:assert/strict";

import { hexToRgb, luminance, mix } from "./color";

assert.deepEqual(hexToRgb("#fff"), { b: 255, g: 255, r: 255 }, "#fff → white");
assert.deepEqual(hexToRgb("000"), { b: 0, g: 0, r: 0 }, "000 (no #) → black");
assert.deepEqual(hexToRgb("#f00"), { b: 0, g: 0, r: 255 }, "#f00 → red");
assert.deepEqual(
  hexToRgb("#ABC"),
  hexToRgb("#aabbcc"),
  "3-digit expands by doubling, case-insensitive",
);

assert.deepEqual(hexToRgb("#112233"), { b: 0x33, g: 0x22, r: 0x11 });

assert.deepEqual(hexToRgb("not-a-hex"), { b: 0, g: 0, r: 0 }, "garbage → black");
assert.deepEqual(hexToRgb("#12"), { b: 0, g: 0, r: 0 }, "wrong length → black");
assert.deepEqual(hexToRgb("#12g456"), { b: 0, g: 0, r: 0 }, "non-hex char → black");

assert.equal(mix("#000000", "#ffffff", 0), "#000000", "mix(a,b,0) == a");
assert.equal(mix("#000000", "#ffffff", 1), "#ffffff", "mix(a,b,1) == b");
assert.equal(mix("#000000", "#ffffff", 0.5), "#808080", "mix midpoint rounds to #808080");

assert.equal(mix("#000000", "#ffffff", -1), "#000000", "amount < 0 clamps to a");
assert.equal(mix("#000000", "#ffffff", 2), "#ffffff", "amount > 1 clamps to b");

assert.equal(luminance("#000000"), 0, "black → 0");
assert.equal(luminance("#ffffff"), 1, "white → 1");
{
  const g = luminance("#00ff00");
  const r = luminance("#ff0000");
  const b = luminance("#0000ff");
  assert.ok(g > r && r > b, `Rec.601 weighting: green > red > blue (${g} > ${r} > ${b})`);
}

console.log("✓ color: 3-digit expand, invalid → black, mix endpoints + clamp, luminance weights");
