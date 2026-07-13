// Self-running checks for the set-builder URL codec — no framework, mirroring the repo's
// node:assert-free style (saved-store.test.ts / search-state.test.ts). Run via `bun test`
// (reports "0 pass" — no describe/it blocks — but throws and fails the process on any failed
// assertion) or `bun src/lib/mix-set.test.ts`.
//
// The load-bearing test is #6: an EXACT expected share URL string, pinning this mirror to the
// web ShareSetButton byte-for-byte so a set built on the phone opens on the web.

import {
  buildMixShareUrl,
  MAX_SET_LENGTH,
  MAX_TASTE_ARTISTS,
  isSetToken,
  mixReasonLabel,
  parseSetParam,
  parseTasteParam,
  searchHitToMixTrack,
  serializeSet,
  serializeTaste,
  setToken,
} from "@/lib/mix-set";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. A set token is a finding Log ID or a 22-char Spotify id; junk is neither.
assertEqual(isSetToken("004.7.2I"), true, "a Log ID is a set token");
assertEqual(isSetToken("3n3Pcfd0Zw8Yb9 mangled"), false, "a mangled id is not a set token");
assertEqual(isSetToken("4iV5W9uYEdYUVa79Axb7Rh"), true, "a 22-char base62 id is a set token");
assertEqual(isSetToken("019.F.1A"), false, "a mixtape coordinate is not a track set token");

// 2. setToken names a row by coordinate when certified, else its Spotify id.
assertEqual(setToken({ logId: "004.7.2I", trackId: "abc" }), "004.7.2I", "certified → coordinate");
assertEqual(
  setToken({ trackId: "4iV5W9uYEdYUVa79Axb7Rh" }),
  "4iV5W9uYEdYUVa79Axb7Rh",
  "uncertified → id",
);

// 3. parseSetParam cleans, de-dupes, preserves order, drops junk.
const parsed = parseSetParam("004.7.2I, 4iV5W9uYEdYUVa79Axb7Rh ,004.7.2I,nope");
assertEqual(parsed.length, 2, "de-duped + junk dropped");
assertEqual(parsed[0], "004.7.2I", "order preserved (Log ID first)");
assertEqual(parsed[1], "4iV5W9uYEdYUVa79Axb7Rh", "the Spotify id follows");
assertEqual(parseSetParam("").length, 0, "empty → empty");
assertEqual(parseSetParam(null).length, 0, "null → empty");

// 4. The set cap holds.
const many = Array.from({ length: 40 }, (_, i) => `00${(i % 9) + 1}.7.${i}A`).join(",");
assertEqual(parseSetParam(many).length <= MAX_SET_LENGTH, true, "capped at MAX_SET_LENGTH");
assertEqual(MAX_SET_LENGTH, 32, "the cap matches the web");

// 5. Taste is lowercased, slug-guarded, de-duped, capped.
const taste = parseTasteParam("Netsky, camo-krooked ,netsky,BAD SLUG!");
assertEqual(taste.length, 2, "taste de-duped + junk dropped");
assertEqual(taste[0], "netsky", "lowercased");
assertEqual(taste[1], "camo-krooked", "hyphen slug kept");
assertEqual(MAX_TASTE_ARTISTS, 10, "taste cap matches the web");

// 6. THE LOAD-BEARING TEST — the exact share URL, byte-for-byte with the web ShareSetButton
//    (`{siteUrl}/mix?set=…[&taste=…]&view=play`). A phone-built set MUST open on the web.
assertEqual(
  buildMixShareUrl(["004.7.2I", "4iV5W9uYEdYUVa79Axb7Rh"], ["netsky", "camo-krooked"]),
  "https://www.fluncle.com/mix?set=004.7.2I,4iV5W9uYEdYUVa79Axb7Rh&taste=netsky,camo-krooked&view=play",
  "the seeded share URL is pinned exactly",
);
assertEqual(
  buildMixShareUrl(["004.7.2I"], []),
  "https://www.fluncle.com/mix?set=004.7.2I&view=play",
  "no taste → no &taste= segment",
);

// 7. serializeSet / serializeTaste are the plain comma join the URL carries.
assertEqual(serializeSet(["a", "b"]), "a,b", "set serialize is a comma join");
assertEqual(serializeTaste(["x", "y"]), "x,y", "taste serialize is a comma join");

// 8. The reason chip maps every relationship to its ratified crew-facing label (no numbers).
assertEqual(
  mixReasonLabel({ kind: "key", relationship: "same_key" }),
  "Same key",
  "same_key label",
);
assertEqual(
  mixReasonLabel({ kind: "bpm", relationship: "tempo_match" }),
  "Tempo locked",
  "tempo label",
);
assertEqual(
  mixReasonLabel({ kind: "sonic", relationship: "close_in_sound" }),
  "Close in sound",
  "sonic label",
);

// 9. A search hit adapts into a chain row: logId rides only on a certified hit (the Unlit
//    Rule, structurally), and the hit's bpm/key are carried so the row renders them.
const certifiedHit = searchHitToMixTrack({
  artists: ["Netsky"],
  bpm: 174,
  certified: true,
  key: "G# minor",
  logId: "004.7.2I",
  title: "Come Alive",
  trackId: "4iV5W9uYEdYUVa79Axb7Rh",
});
assertEqual(certifiedHit.logId, "004.7.2I", "a certified hit keeps its coordinate");
assertEqual(certifiedHit.key, "G# minor", "the hit's key is carried");
const unlitHit = searchHitToMixTrack({
  artists: ["Unknown"],
  certified: false,
  logId: "should.never.ride",
  title: "Untitled",
  trackId: "4iV5W9uYEdYUVa79Axb7Rh",
});
assertEqual(unlitHit.logId, undefined, "an uncertified hit never carries a coordinate");
