// Self-running checks for the account's saved-sets pure logic — no framework, mirroring the
// repo's node:assert-free style (saved-sync.test.ts / mix-store.test.ts). Run via `bun test`
// or `bun src/lib/saved-sets.test.ts`.
//
// These pin the POST body assembly, the tolerant list parse (junk in the wire must never
// crash a signed-in account view or resurrect a partial row), the get_track→MixTrack adapter,
// and the token→chain hydration (order preserved, unresolved tokens dropped, duplicates
// collapsed) with the token fetcher mocked.

import { type MixTrack } from "@fluncle/contracts";
import {
  adaptTrackToMixTrack,
  buildSaveSetBody,
  parseRemoteSetsList,
  type RemoteSavedSet,
  resolveChainFromTokens,
} from "@/lib/saved-sets";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. buildSaveSetBody keys the body exactly as the web posts (`{ set, taste }`), taste and all.
const body = buildSaveSetBody("004.7.2I,4iV5W9uYEdYUVa79Axb7Rh", "netsky,camo-krooked");
assertEqual(body.set, "004.7.2I,4iV5W9uYEdYUVa79Axb7Rh", "set rides verbatim");
assertEqual(body.taste, "netsky,camo-krooked", "taste rides verbatim");
assertEqual(buildSaveSetBody("004.7.2I", "").taste, "", "an empty taste still rides (web parity)");

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

// 3. adaptTrackToMixTrack marks a get_track finding certified and carries its coordinate.
const adapted = adaptTrackToMixTrack({
  artists: ["Netsky"],
  durationMs: 240_000,
  key: "G# minor",
  logId: "004.7.2I",
  spotifyUrl: "https://open.spotify.com/track/x",
  title: "Rio",
  trackId: "t-1",
});
assertEqual(adapted.certified, true, "a get_track finding is always certified");
assertEqual(adapted.logId, "004.7.2I", "the coordinate rides as logId");
assertEqual(adapted.title, "Rio", "title carried");

// 4. resolveChainFromTokens walks tokens in order, drops the unresolved, collapses dupes.
const certified = (logId: string): MixTrack => ({
  artists: ["Netsky"],
  certified: true,
  durationMs: 240_000,
  logId,
  title: `Track ${logId}`,
  trackId: `t-${logId}`,
});

const resolvedCalls: string[] = [];
const fetcher = async (token: string): Promise<MixTrack | null> => {
  resolvedCalls.push(token);
  // "004.7.2I" and "005.1.0" resolve; the Spotify-id token (uncertified) does not.
  if (token === "004.7.2I") {
    return certified("004.7.2I");
  }
  if (token === "005.1.0") {
    return certified("005.1.0");
  }
  return null;
};

const chain = await resolveChainFromTokens(
  ["004.7.2I", "4iV5W9uYEdYUVa79Axb7Rh", "005.1.0", "004.7.2I"],
  fetcher,
);
assertEqual(chain.length, 2, "the two certified tokens resolve; the uncertified one drops");
assertEqual(chain[0]?.logId, "004.7.2I", "token order is preserved (a set is a sequence)");
assertEqual(chain[1]?.logId, "005.1.0", "the second certified token follows");
assertEqual(resolvedCalls.length, 3, "the duplicate token is not fetched twice");

// A total wipe-out (every token unresolvable) yields an empty chain, never a throw.
const empty = await resolveChainFromTokens(["zzz"], async () => null);
assertEqual(empty.length, 0, "all-unresolved → empty chain, no throw");

console.log("saved-sets.test.ts: all checks passed");
