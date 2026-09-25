import { buildMixShareUrl, searchHitToMixTrack } from "./mix-set";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(
  buildMixShareUrl(["004.7.2I", "4iV5W9uYEdYUVa79Axb7Rh"], ["netsky", "camo-krooked"]),
  "https://www.fluncle.com/mix?set=004.7.2I,4iV5W9uYEdYUVa79Axb7Rh&taste=netsky,camo-krooked&view=play",
  "a set with taste opens in the web player",
);
assertEqual(
  buildMixShareUrl(["004.7.2I"], []),
  "https://www.fluncle.com/mix?set=004.7.2I&view=play",
  "a set without taste omits the taste parameter",
);

const certified = searchHitToMixTrack({
  artists: ["Netsky"],
  bpm: 174,
  certified: true,
  key: "G# minor",
  logId: "004.7.2I",
  title: "Come Alive",
  trackId: "4iV5W9uYEdYUVa79Axb7Rh",
});
const unlit = searchHitToMixTrack({
  artists: ["Unknown"],
  certified: false,
  logId: "should.never.ride",
  title: "Untitled",
  trackId: "4iV5W9uYEdYUVa79Axb7Rh",
});

assertEqual(certified.logId, "004.7.2I", "a certified hit carries its coordinate");
assertEqual(certified.bpm, 174, "a hit carries its BPM");
assertEqual(certified.key, "G# minor", "a hit carries its key");
assertEqual(unlit.logId, undefined, "an uncertified hit has no coordinate");
