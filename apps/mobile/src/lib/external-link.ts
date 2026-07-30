// Every link that leaves the app goes through this decision.
//
// After 1.1 ships, the web API starts serving Spotify links as HOP urls —
// `https://www.fluncle.com/out/spotify/<trackId>`, a 302 to open.spotify.com. Handed
// straight to `Linking.openURL`, a hop url opens SAFARI (iOS routes by the url it is
// given, and fluncle.com is not a Spotify universal link), and the crew lands on the
// Spotify WEB player instead of the app. So: resolve the redirect first, hand iOS the
// FINAL url, and the tap keeps opening the Spotify app the way it does today.
//
// This module is deliberately framework-free — no react-native, no expo — so the whole
// decision is unit-testable with a fake fetcher and the suite never needs the network.
// The thin native seam (real fetch + `Linking.openURL`) is ./open-external-url.ts.
//
// DORMANT until the server flip: no DTO or contract changes ride here, and no url the
// API serves today matches `isHopUrl`, so every existing link takes the passthrough path
// and behaves exactly as before. This lands first so the binary is ready for the flip.

// A response, structurally. Only the final url is read, so the real `fetch` satisfies
// this and a test fake is three lines.
export type HopFetchResponse = { readonly url: string };
export type HopFetcher = (url: string) => Promise<HopFetchResponse>;

// The hosts that serve hops. Fluncle's own apex and www, nothing else — a hop is minted
// by the web API, which lives on exactly these two. Deliberately NOT any-fluncle.com-
// subdomain: `found.fluncle.com` (the media CDN) and `radio.`/`galaxy.` never mint hops,
// and a narrow list means a url we do not understand takes the untouched passthrough
// instead of an extra round trip.
const HOP_HOSTS = new Set(["fluncle.com", "www.fluncle.com"]);
const HOP_PATH_PREFIX = "/out/";

// Parsed by hand rather than with `new URL`, on purpose. React Native's `URL` is a
// regex shim (react-native/Libraries/Blob/URL.js), not WHATWG: its constructor does NOT
// throw on junk, and its `hostname` getter mis-splits some userinfo shapes — so a
// `new URL` + try/catch guard would take one path under `bun test` and a different one
// on device, which is exactly the divergence a pure module exists to avoid. One regex,
// same answer everywhere.
//
// Group 1 scheme, group 2 authority (may carry userinfo and a port), group 3 path.
const HTTP_URL = /^(https?):\/\/([^/?#]*)([^?#]*)/i;

type ParsedUrl = { readonly host: string; readonly path: string };

function parseHttpUrl(url: string): ParsedUrl | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  const match = HTTP_URL.exec(url.trim());
  if (!match) {
    return undefined;
  }

  const authority = match[2] ?? "";
  // WHATWG takes everything after the LAST "@" as the host, so
  // `https://fluncle.com@evil.example/out/x` is a request to evil.example — and must not
  // read as one of ours.
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostAndPort.replace(/:\d*$/, "").toLowerCase();
  if (!host) {
    return undefined;
  }

  const path = match[3] === "" ? "/" : match[3];
  return { host, path };
}

// Is this an http(s) url at all? The resolver's guard against a fetcher handing back
// something unopenable (a data: url, a bare host, an empty string).
export function isHttpUrl(url: string): boolean {
  return parseHttpUrl(url) !== undefined;
}

// A hop url: one of Fluncle's link-out redirects. Never throws — anything unparseable is
// simply not a hop, and takes the passthrough.
export function isHopUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return false;
  }
  return HOP_HOSTS.has(parsed.host) && parsed.path.startsWith(HOP_PATH_PREFIX);
}

// Follow a hop to the url it points at.
//
// MECHANISM (verify on device): React Native's fetch follows redirects by default, and
// the settled response's `url` is the FINAL url of the chain — that is the documented
// primary path, but it rides RN's native networking layer rather than a spec-complete
// fetch, so treat it as verify-on-device (the 1.1 checklist line). If it proves
// unreliable there, the known fallback is a `redirect: "manual"`-capable request and
// reading the `Location` header. That path is deliberately NOT built here: the guard
// below already degrades safely, so an unreliable `response.url` costs a Safari bounce,
// never a broken link.
//
// Also deliberate: a plain GET, no `method: "HEAD"`. A GET is what the browser does, so
// the hop route is guaranteed to handle it; HEAD would save the response body but a hop
// route that answered 405 instead of redirecting would silently degrade every tap.
//
// FALLBACK CONTRACT — return the ORIGINAL hop url whenever the resolve is not trustworthy
// (the fetch threw, or the final url is empty / non-http(s) / still a hop, meaning no
// redirect was observed). Opening the hop itself still 302s to Spotify's web player: a
// degraded-but-working tap. And offline neither url opens anything, so degrading costs
// nothing there either. Never throws.
export async function resolveHopUrl(url: string, fetcher: HopFetcher): Promise<string> {
  try {
    const response = await fetcher(url);
    const final = typeof response?.url === "string" ? response.url.trim() : "";
    if (!final) {
      return url;
    }
    if (!isHttpUrl(final)) {
      return url;
    }
    // Still a hop: the chain did not move, so we learned nothing.
    if (isHopUrl(final)) {
      return url;
    }
    return final;
  } catch {
    return url;
  }
}

// The whole decision: what url should actually be opened?
//
// A non-hop url passes through UNTOUCHED and never reaches the fetcher — zero behavior
// change, and zero extra network, for every link the app opens today.
export async function openTarget(url: string, fetcher: HopFetcher): Promise<string> {
  if (!isHopUrl(url)) {
    return url;
  }
  return await resolveHopUrl(url, fetcher);
}
