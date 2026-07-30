// Self-running checks for the external-link decision — no framework, mirroring the
// repo's node:assert-free style (saved-store.test.ts, storage-migration.test.ts). Run via
// `bun test` (reports "0 pass" — no describe/it blocks — but throws and fails the process
// on any failed assertion) or `bun src/lib/external-link.test.ts`.
//
// These pin the hop recognition (which host, which path, and junk in → false, never a
// throw), the resolver's fallback contract (every untrustworthy resolve returns the
// ORIGINAL hop url), and the passthrough guarantee that matters most: a url that is not a
// hop never touches the fetcher, so no link the app opens today pays a round trip.
//
// The fetcher is always a fake — this suite reaches no network (see ./no-network.test.ts).

import {
  type HopFetcher,
  isHopUrl,
  isHttpUrl,
  openTarget,
  resolveHopUrl,
} from "@/lib/external-link";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const HOP = "https://www.fluncle.com/out/spotify/4iV5W9uYEdYUVa79Axb7Rh";
const SPOTIFY = "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh";

// A fetcher that reports a final url, counting its calls.
function fakeFetcher(url: string): HopFetcher & { calls: number } {
  const fetcher = (): Promise<{ url: string }> => {
    fetcher.calls += 1;
    return Promise.resolve({ url });
  };
  fetcher.calls = 0;
  return fetcher;
}

function throwingFetcher(): HopFetcher & { calls: number } {
  const fetcher = (): Promise<{ url: string }> => {
    fetcher.calls += 1;
    return Promise.reject(new Error("offline"));
  };
  fetcher.calls = 0;
  return fetcher;
}

// 1. isHopUrl — the truth table.

// Both hop hosts, and the /out/ prefix is required.
assertEqual(isHopUrl(HOP), true, "www hop");
assertEqual(isHopUrl("https://fluncle.com/out/spotify/abc"), true, "bare host hop");
assertEqual(isHopUrl("http://fluncle.com/out/spotify/abc"), true, "http hop");
assertEqual(isHopUrl("https://WWW.FLUNCLE.COM/out/spotify/abc"), true, "host is case-insensitive");
assertEqual(isHopUrl("https://www.fluncle.com/out/apple/abc?x=1"), true, "query is ignored");
assertEqual(isHopUrl("https://www.fluncle.com:443/out/spotify/abc"), true, "a port is stripped");

// Other fluncle.com paths are not hops — the app opens plenty of them.
assertEqual(isHopUrl("https://www.fluncle.com/log/024.7.2R"), false, "a /log page is not a hop");
assertEqual(
  isHopUrl("https://www.fluncle.com/artist/netsky"),
  false,
  "an entity page is not a hop",
);
assertEqual(isHopUrl("https://www.fluncle.com/"), false, "the homepage is not a hop");
assertEqual(isHopUrl("https://www.fluncle.com/outer/space"), false, "/out must be a full segment");
assertEqual(isHopUrl("https://www.fluncle.com/out"), false, "/out with no target is not a hop");

// Other hosts never match, however they dress themselves up.
assertEqual(isHopUrl(SPOTIFY), false, "spotify is not a hop");
assertEqual(isHopUrl("https://found.fluncle.com/out/spotify/abc"), false, "the CDN mints no hops");
assertEqual(isHopUrl("https://evil.example/out/spotify/abc"), false, "a stranger's /out/ path");
assertEqual(isHopUrl("https://notfluncle.com/out/x"), false, "a suffix host does not match");
assertEqual(
  isHopUrl("https://fluncle.com.evil.example/out/x"),
  false,
  "a prefix host does not match",
);
// Userinfo: the real host is what follows the LAST "@", so this is a request to
// evil.example and must not read as one of ours.
assertEqual(isHopUrl("https://fluncle.com@evil.example/out/x"), false, "userinfo does not spoof");
assertEqual(
  isHopUrl("https://evil.example/x@fluncle.com/out/y"),
  false,
  "an @ inside the path does not spoof",
);

// Junk in → false, never a throw.
assertEqual(isHopUrl(""), false, "empty string");
assertEqual(isHopUrl("not a url at all"), false, "prose");
assertEqual(isHopUrl("/out/spotify/abc"), false, "a bare path is not a url");
assertEqual(isHopUrl("fluncle.com/out/spotify/abc"), false, "no scheme");
assertEqual(isHopUrl("spotify:track:abc"), false, "a non-http scheme");
assertEqual(isHopUrl("https://"), false, "a scheme with no host");
assertEqual(isHopUrl("javascript:alert(1)"), false, "a javascript url");
// The signature says string, but a DTO field can arrive as anything at runtime.
assertEqual(isHopUrl(undefined as unknown as string), false, "undefined");
assertEqual(isHopUrl(null as unknown as string), false, "null");

// isHttpUrl, the resolver's openability guard.
assertEqual(isHttpUrl(SPOTIFY), true, "a spotify url is http");
assertEqual(isHttpUrl("data:text/html,hi"), false, "a data url is not http");
assertEqual(isHttpUrl(""), false, "empty is not http");

// 2. resolveHopUrl — follows the redirect, and degrades to the original on anything else.

{
  const fetcher = fakeFetcher(SPOTIFY);
  assertEqual(await resolveHopUrl(HOP, fetcher), SPOTIFY, "follows the hop to its destination");
  assertEqual(fetcher.calls, 1, "one round trip");
}

{
  // The fetch throws (offline, DNS, a timeout) → the hop itself, which still 302s.
  const fetcher = throwingFetcher();
  assertEqual(await resolveHopUrl(HOP, fetcher), HOP, "a thrown fetch returns the original");
  assertEqual(fetcher.calls, 1, "it did try");
}

assertEqual(
  await resolveHopUrl(HOP, fakeFetcher("")),
  HOP,
  "an empty final url returns the original",
);
assertEqual(
  await resolveHopUrl(HOP, fakeFetcher("   ")),
  HOP,
  "a whitespace final url returns the original",
);
assertEqual(
  await resolveHopUrl(HOP, fakeFetcher(HOP)),
  HOP,
  "a final url that is still the hop returns the original (no redirect observed)",
);
assertEqual(
  await resolveHopUrl(HOP, fakeFetcher("https://fluncle.com/out/spotify/other")),
  HOP,
  "any other hop is still a hop, so the original stands",
);
assertEqual(
  await resolveHopUrl(HOP, fakeFetcher("data:text/html,nope")),
  HOP,
  "a non-http final url returns the original",
);
assertEqual(
  await resolveHopUrl(HOP, fakeFetcher("open.spotify.com/track/abc")),
  HOP,
  "a schemeless final url returns the original",
);

{
  // A response with no usable url field at all — never throws out.
  const fetcher = (): Promise<{ url: string }> =>
    Promise.resolve({ url: undefined as unknown as string });
  assertEqual(await resolveHopUrl(HOP, fetcher), HOP, "a missing url returns the original");
}

{
  // A fetcher that throws synchronously rather than rejecting.
  const fetcher = (): Promise<{ url: string }> => {
    throw new Error("sync boom");
  };
  assertEqual(await resolveHopUrl(HOP, fetcher), HOP, "a synchronous throw returns the original");
}

// 3. openTarget — the passthrough is untouched, and costs no round trip.

{
  const fetcher = fakeFetcher(SPOTIFY);
  assertEqual(await openTarget(SPOTIFY, fetcher), SPOTIFY, "a spotify url passes through");
  assertEqual(fetcher.calls, 0, "a non-hop url never touches the fetcher");
}

{
  const fetcher = fakeFetcher(SPOTIFY);
  const webPage = "https://www.fluncle.com/artist/netsky";
  assertEqual(await openTarget(webPage, fetcher), webPage, "a fluncle web page passes through");
  assertEqual(fetcher.calls, 0, "and pays no round trip");
}

{
  const fetcher = fakeFetcher(SPOTIFY);
  assertEqual(await openTarget("not a url", fetcher), "not a url", "junk passes through unchanged");
  assertEqual(fetcher.calls, 0, "junk pays no round trip");
}

{
  const fetcher = fakeFetcher(SPOTIFY);
  assertEqual(await openTarget(HOP, fetcher), SPOTIFY, "a hop resolves first");
  assertEqual(fetcher.calls, 1, "exactly one round trip for a hop");
}
