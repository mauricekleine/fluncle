// Self-running checks for the device-local set store — no framework, mirroring the repo's
// node:assert-free style (saved-store.test.ts). Run via `bun test` or `bun
// src/lib/mix-store.test.ts`.
//
// These pin the add idempotence + cap, remove-by-token, the chain-token projection, the
// round trip, and the tolerant deserialize (garbage in storage must never crash the app or
// resurrect a partial row).

import { type MixTrack } from "@fluncle/contracts";
import {
  addTrack,
  chainTokens,
  deserialize,
  inChain,
  removeTrack,
  serialize,
} from "@/lib/mix-store";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const certified = (logId: string): MixTrack => ({
  artists: ["Netsky"],
  certified: true,
  durationMs: 240_000,
  logId,
  title: `Track ${logId}`,
  trackId: `t-${logId}`,
});

const uncertified = (trackId: string): MixTrack => ({
  artists: ["Unknown"],
  certified: false,
  durationMs: 240_000,
  title: `Track ${trackId}`,
  trackId,
});

// 1. addTrack appends; re-adding the same row (by token) is a no-op.
let chain = addTrack([], certified("004.7.2I"));
assertEqual(chain.length, 1, "first add lands");
assertEqual(inChain(chain, certified("004.7.2I")), true, "now in the chain");
chain = addTrack(chain, certified("004.7.2I"));
assertEqual(chain.length, 1, "re-adding the same row is a no-op");
chain = addTrack(chain, uncertified("4iV5W9uYEdYUVa79Axb7Rh"));
assertEqual(chain.length, 2, "a different row appends");

// 2. Order is preserved (a set is a sequence); the token projection follows it.
const tokens = chainTokens(chain);
assertEqual(tokens[0], "004.7.2I", "certified projects to its coordinate, first");
assertEqual(tokens[1], "4iV5W9uYEdYUVa79Axb7Rh", "uncertified projects to its id, second");

// 3. removeTrack drops by token, leaves the rest.
const pruned = removeTrack(chain, "004.7.2I");
assertEqual(pruned.length, 1, "remove drops one");
assertEqual(pruned[0]?.trackId, "4iV5W9uYEdYUVa79Axb7Rh", "the other survives");

// 4. The cap holds — a 33rd add is refused.
let big: MixTrack[] = [];
for (let i = 0; i < 40; i += 1) {
  big = addTrack(big, certified(`00${(i % 9) + 1}.7.${i % 9}A`));
}
assertEqual(big.length <= 32, true, "chain capped at MAX_SET_LENGTH");

// 5. Round-trip serialize → deserialize preserves the chain + taste.
const roundTrip = deserialize(serialize({ chain, taste: ["netsky", "camo-krooked"] }));
assertEqual(roundTrip.chain.length, 2, "both rows survive the round trip");
assertEqual(roundTrip.chain[0]?.logId, "004.7.2I", "chain order preserved");
assertEqual(roundTrip.taste.length, 2, "taste survives");
assertEqual(roundTrip.taste[0], "netsky", "taste order preserved");

// 6. Tolerant deserialize: null, garbage, wrong version, partial rows → empty/dropped.
assertEqual(deserialize(null).chain.length, 0, "null → empty chain");
assertEqual(deserialize("not json {{{").chain.length, 0, "invalid JSON → empty");
assertEqual(
  deserialize(JSON.stringify({ chain: [], taste: [], version: 99 })).chain.length,
  0,
  "wrong version → empty",
);
assertEqual(
  deserialize(JSON.stringify({ chain: [{ trackId: "x" }], taste: [], version: 1 })).chain.length,
  0,
  "a row missing required fields is dropped (no title/artists/certified)",
);
assertEqual(
  deserialize(JSON.stringify({ chain: "nope", taste: 5, version: 1 })).taste.length,
  0,
  "non-array chain/taste → empty",
);
