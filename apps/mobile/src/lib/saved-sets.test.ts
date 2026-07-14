// Self-running checks for the account's saved-sets pure logic — no framework, mirroring the
// repo's node:assert-free style (saved-sync.test.ts / mix-store.test.ts). Run via `bun test`
// or `bun src/lib/saved-sets.test.ts`.
//
// These pin the POST body assembly, the tolerant list parse (junk in the wire must never
// crash a signed-in account view or resurrect a partial row), and the one-shot set hydration
// through the `list_set_tracks` op (its rows pass through in order; an empty seed short-circuits
// with no round trip; a fault degrades to an empty chain) with the op fetcher mocked.

import { type MixTrack } from "@fluncle/contracts";
import {
  buildSaveSetBody,
  parseRemoteSetsList,
  type RemoteSavedSet,
  resolveSavedSet,
} from "@/lib/saved-sets";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. buildSaveSetBody keys the body exactly as the web posts (`{ name, set, taste }`), name
//    trimmed, taste and all.
const body = buildSaveSetBody(
  "  Friday warmup  ",
  "004.7.2I,4iV5W9uYEdYUVa79Axb7Rh",
  "netsky,camo-krooked",
);
assertEqual(body.name, "Friday warmup", "the name is trimmed");
assertEqual(body.set, "004.7.2I,4iV5W9uYEdYUVa79Axb7Rh", "set rides verbatim");
assertEqual(body.taste, "netsky,camo-krooked", "taste rides verbatim");
assertEqual(
  buildSaveSetBody("x", "004.7.2I", "").taste,
  "",
  "an empty taste still rides (web parity)",
);

// 2. parseRemoteSetsList reads the envelope, dropping malformed rows and surviving junk.
const good: RemoteSavedSet = {
  createdAt: "2026-07-12T10:00:00.000Z",
  id: "set-1",
  name: "Friday warmup",
  setTokens: "004.7.2I",
  updatedAt: "2026-07-12T10:00:00.000Z",
};
const parsed = parseRemoteSetsList({
  ok: true,
  savedSets: [
    good,
    { id: "set-2", name: "no tokens" }, // missing setTokens/dates → dropped
    {
      createdAt: "x",
      id: "set-3",
      name: "bad taste",
      setTokens: "005.1.0",
      taste: 5,
      updatedAt: "x",
    }, // taste wrong type → dropped
    "not an object", // → dropped
  ],
});
assertEqual(parsed.length, 1, "only the well-formed row survives");
assertEqual(parsed[0]?.id, "set-1", "the good row is kept");
assertEqual(parseRemoteSetsList(null).length, 0, "null body → []");
assertEqual(parseRemoteSetsList({ savedSets: "nope" }).length, 0, "non-array savedSets → []");
assertEqual(parseRemoteSetsList({}).length, 0, "absent savedSets → []");

// 3. resolveSavedSet hands the whole `?set=` string to the op ONCE and passes its rows through in
// order — a MIXED chain (a certified finding + an uncertified catalogue track) hydrates whole,
// which the old per-token get_track walk could not do (it dropped the uncertified token).
const certified: MixTrack = {
  artists: ["Netsky"],
  certified: true,
  durationMs: 240_000,
  logId: "004.7.2I",
  title: "Rio",
  trackId: "t-rio",
};
const uncertified: MixTrack = {
  artists: ["Unknown Artist"],
  certified: false,
  durationMs: 300_000,
  title: "Catalogue Roller",
  trackId: "4iV5W9uYEdYUVa79Axb7Rh",
};

const fetchCalls: string[] = [];
const fetchSet = async (set: string): Promise<MixTrack[]> => {
  fetchCalls.push(set);
  // The op resolves the whole chain in order — both kinds — and returns MixTrack rows.
  return [certified, uncertified];
};

const chain = await resolveSavedSet("004.7.2I,4iV5W9uYEdYUVa79Axb7Rh", fetchSet);
assertEqual(chain.length, 2, "both the certified and the uncertified token hydrate");
assertEqual(chain[0]?.trackId, "t-rio", "order is preserved (a set is a sequence)");
assertEqual(chain[1]?.certified, false, "the uncertified catalogue track rides in the chain");
assertEqual(fetchCalls.length, 1, "the whole set is hydrated in ONE op read, not per-token");
assertEqual(
  fetchCalls[0],
  "004.7.2I,4iV5W9uYEdYUVa79Axb7Rh",
  "the raw set string is handed through",
);

// 4. An empty / whitespace seed short-circuits with no round trip.
const emptyCalls: string[] = [];
const empty = await resolveSavedSet("  ", async (set) => {
  emptyCalls.push(set);
  return [];
});
assertEqual(empty.length, 0, "an empty seed yields an empty chain");
assertEqual(emptyCalls.length, 0, "an empty seed never calls the op");

// 5. A fault (network/parse) degrades to an empty chain, never a throw that blanks the tab.
const faulted = await resolveSavedSet("004.7.2I", async () => {
  throw new Error("network down");
});
assertEqual(faulted.length, 0, "a fault → empty chain, no throw");

console.log("saved-sets.test.ts: all checks passed");
