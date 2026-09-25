import assert from "node:assert/strict";

import {
  isRemix,
  stripVersionSuffix,
  versionMatches,
  versionTokens,
} from "@fluncle/contracts/util";

const REMIX = "In And Out Of Phase - Calyx & TeeBee Remix";

assert.equal(isRemix(REMIX), true, "a third-party remix is a remix");
assert.equal(isRemix("Tarantula (Bootleg)"), true, "a bootleg is a remix");
assert.equal(isRemix("Inner City Life - Foreign Concept VIP"), true, "a VIP is a remix");
assert.equal(isRemix("In And Out Of Phase"), false, "the bare original is not a remix");
assert.equal(isRemix("Days Like These - Original Mix"), false, "Original Mix is not a remix");
assert.equal(isRemix("The Nine - Radio Edit"), false, "a radio edit is not a remix");

assert.equal(
  stripVersionSuffix("Days Like These - Original Mix"),
  "Days Like These",
  "strips the version tail",
);
assert.equal(stripVersionSuffix(REMIX), "In And Out Of Phase", "strips the remixer tail");
assert.equal(stripVersionSuffix("Now - Forever"), "Now - Forever", "leaves a plain A - B title");

{
  const dash = versionTokens(REMIX);
  assert.ok(dash.has("calyx") && dash.has("teebee") && dash.has("remix"), "dash remixer tokens");
  const bracket = versionTokens("Tarantula (Noisia Remix)");
  assert.ok(bracket.has("noisia") && bracket.has("remix"), "bracket remixer tokens");
  assert.equal(versionTokens("In And Out Of Phase").size, 0, "the original has no version tokens");
}

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
