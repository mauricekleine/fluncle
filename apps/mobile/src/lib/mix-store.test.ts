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

let chain = addTrack([], certified("004.7.2I"));
assertEqual(chain.length, 1, "first add lands");
assertEqual(inChain(chain, certified("004.7.2I")), true, "now in the chain");
chain = addTrack(chain, certified("004.7.2I"));
assertEqual(chain.length, 1, "re-adding the same row is a no-op");
chain = addTrack(chain, uncertified("4iV5W9uYEdYUVa79Axb7Rh"));
assertEqual(chain.length, 2, "a different row appends");

const tokens = chainTokens(chain);
assertEqual(tokens[0], "004.7.2I", "certified projects to its coordinate, first");
assertEqual(tokens[1], "4iV5W9uYEdYUVa79Axb7Rh", "uncertified projects to its id, second");

const pruned = removeTrack(chain, "004.7.2I");
assertEqual(pruned.length, 1, "remove drops one");
assertEqual(pruned[0]?.trackId, "4iV5W9uYEdYUVa79Axb7Rh", "the other survives");

let big: MixTrack[] = [];
for (let i = 0; i < 40; i += 1) {
  big = addTrack(big, certified(`00${(i % 9) + 1}.7.${i % 9}A`));
}
assertEqual(big.length <= 32, true, "chain capped at MAX_SET_LENGTH");

const roundTrip = deserialize(
  serialize({
    chain,
    sourceSetId: "set-1",
    sourceSetName: "Friday warmup",
    taste: ["netsky", "camo-krooked"],
  }),
);
assertEqual(roundTrip.chain.length, 2, "both rows survive the round trip");
assertEqual(roundTrip.chain[0]?.logId, "004.7.2I", "chain order preserved");
assertEqual(roundTrip.taste.length, 2, "taste survives");
assertEqual(roundTrip.taste[0], "netsky", "taste order preserved");
assertEqual(roundTrip.sourceSetId, "set-1", "the source set id survives");
assertEqual(roundTrip.sourceSetName, "Friday warmup", "the source set name survives");

const noRef = deserialize(serialize({ chain, taste: [] }));
assertEqual(noRef.sourceSetId, undefined, "absent id → undefined");
assertEqual(noRef.sourceSetName, undefined, "absent name → undefined");

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
