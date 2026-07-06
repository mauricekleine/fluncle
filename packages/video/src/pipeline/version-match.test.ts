// Version-aware matching: the gate that stops a remix finding from resolving to
// the bare ORIGINAL (and vice-versa). The regression case is a real DnB remix —
// "In And Out Of Phase - Calyx & TeeBee Remix" must NOT match the original
// "In And Out Of Phase", and must match its own remix. No framework (matches the
// rest of this package's self-running asserts). Run: `bun src/pipeline/version-match.test.ts`.

import assert from "node:assert/strict";

import {
  isRemix,
  stripVersionSuffix,
  versionMatches,
  versionTokens,
} from "@fluncle/contracts/util";

const REMIX = "In And Out Of Phase - Calyx & TeeBee Remix";

// 1. isRemix: third-party reworks vs the original / the artist's own cuts.
assert.equal(isRemix(REMIX), true, "a third-party remix is a remix");
assert.equal(isRemix("Tarantula (Bootleg)"), true, "a bootleg is a remix");
assert.equal(isRemix("Inner City Life - Foreign Concept VIP"), true, "a VIP is a remix");
assert.equal(isRemix("In And Out Of Phase"), false, "the bare original is not a remix");
assert.equal(isRemix("Days Like These - Original Mix"), false, "Original Mix is not a remix");
assert.equal(isRemix("The Nine - Radio Edit"), false, "a radio edit is not a remix");

// 2. stripVersionSuffix: drop a version tail, leave an ordinary "A - B" title alone.
assert.equal(
  stripVersionSuffix("Days Like These - Original Mix"),
  "Days Like These",
  "strips the version tail",
);
assert.equal(stripVersionSuffix(REMIX), "In And Out Of Phase", "strips the remixer tail");
assert.equal(stripVersionSuffix("Now - Forever"), "Now - Forever", "leaves a plain A - B title");

// 3. versionTokens: read the remixer name out of dash + bracket descriptors.
{
  const dash = versionTokens(REMIX);
  assert.ok(dash.has("calyx") && dash.has("teebee") && dash.has("remix"), "dash remixer tokens");
  const bracket = versionTokens("Tarantula (Noisia Remix)");
  assert.ok(bracket.has("noisia") && bracket.has("remix"), "bracket remixer tokens");
  assert.equal(versionTokens("In And Out Of Phase").size, 0, "the original has no version tokens");
}

// 4. versionMatches — the wrong-recording gate.
// A remix finding must NOT match the original or a different remix…
assert.equal(versionMatches(REMIX, "In And Out Of Phase"), false, "remix ≠ bare original");
assert.equal(
  versionMatches(REMIX, "In And Out Of Phase - Original Mix"),
  false,
  "remix ≠ Original Mix",
);
assert.equal(
  versionMatches(REMIX, "In And Out Of Phase - Noisia Remix"),
  false,
  "remix ≠ a different remix",
);
// …and MUST match its own remix (dash or bracket form).
assert.equal(
  versionMatches(REMIX, "In And Out Of Phase - Calyx & TeeBee Remix"),
  true,
  "remix = its own remix (dash)",
);
assert.equal(
  versionMatches(REMIX, "In And Out Of Phase (Calyx & TeeBee Remix)"),
  true,
  "remix = its own remix (bracket)",
);
// An original finding must reject a third-party remix and accept the original.
assert.equal(versionMatches("In And Out Of Phase", REMIX), false, "original ≠ a third-party remix");
assert.equal(
  versionMatches("Days Like These - Original Mix", "Days Like These"),
  true,
  "Original Mix = bare original",
);
assert.equal(
  versionMatches("The Nine", "The Nine - Radio Edit"),
  true,
  "original = the artist's radio edit",
);
// An unnamed "- Remix" finding accepts any remix (best we can assert).
assert.equal(
  versionMatches("Tarantula - Remix", "Tarantula - Some DJ Remix"),
  true,
  "unnamed remix accepts a remix",
);
assert.equal(
  versionMatches("Tarantula - Remix", "Tarantula"),
  false,
  "unnamed remix still rejects the original",
);

console.log(
  "✓ version-match: isRemix / stripVersionSuffix / versionTokens + the remix↔original gate",
);
