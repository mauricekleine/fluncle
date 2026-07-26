// Client-side referrer classification for the /log finding page. A visitor who
// clicks a social caption lands on fluncle.com/<coordinate>, which 301s to
// /log/<logId>; the referrer header (and document.referrer) survives that
// redirect, so an arrival from TikTok/YouTube/Instagram/Bluesky carries a social
// referrer we can read AFTER hydration.
//
// This is progressive enhancement ONLY. Public /log responses are edge-cached and
// loader-rendered, so the server response MUST NOT vary on the referrer — nothing
// here runs on the server or in the loader. The classifier is a pure function (so
// it's unit-testable); `useSocialArrival` is the thin post-mount hook the page
// reads.

import { useEffect, useState } from "react";

/** The social platforms whose arrivals the /log page acknowledges. */
export type SocialPlatform = "bluesky" | "instagram" | "tiktok" | "youtube";

// The allowlist: registrable domain → platform. Matching is host-suffix based, so
// every platform-owned subdomain counts as that platform — the YouTube share host
// (m.youtube.com), the TikTok share/shortener host (vm.tiktok.com), the Instagram
// link wrapper (l.instagram.com), and so on. `youtu.be` is YouTube's own share
// domain, not a third-party shortener, so it maps to youtube; generic shorteners
// (t.co and friends) are deliberately absent — they carry no platform identity.
const SOCIAL_DOMAINS: ReadonlyArray<readonly [string, SocialPlatform]> = [
  ["tiktok.com", "tiktok"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["instagram.com", "instagram"],
  ["bsky.app", "bluesky"],
];

const hostMatches = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * Classify a `document.referrer` value against the social allowlist.
 *
 * Returns the platform for an arrival from one of the four supported platforms
 * (or any of its platform-owned subdomains), and `null` for everything else: an
 * empty referrer (a direct hit or a stripped referrer), an internal navigation
 * (our own host), an unparseable value, and any off-allowlist site including
 * generic link shorteners.
 *
 * @param referrer      `document.referrer` (a full URL, or `""` when absent)
 * @param currentOrigin `window.location.origin`, used to reject same-site referrers
 */
export function classifySocialReferrer(
  referrer: string,
  currentOrigin: string,
): SocialPlatform | null {
  if (!referrer) {
    return null;
  }

  let referrerHost: string;

  try {
    referrerHost = new URL(referrer).hostname.toLowerCase();
  } catch {
    // A referrer that isn't a valid URL is junk — treat it as no arrival.
    return null;
  }

  let currentHost = "";

  try {
    currentHost = new URL(currentOrigin).hostname.toLowerCase();
  } catch {
    currentHost = "";
  }

  // Internal navigation carries our own host (or a subdomain of it) as the
  // referrer — never a social arrival.
  if (currentHost && hostMatches(referrerHost, currentHost)) {
    return null;
  }

  for (const [domain, platform] of SOCIAL_DOMAINS) {
    if (hostMatches(referrerHost, domain)) {
      return platform;
    }
  }

  return null;
}

/**
 * Post-mount hook: the social platform this page was arrived from, or `null`.
 *
 * `null` on the server and the first client render (so SSR and hydration agree —
 * no mismatch), then the real verdict after mount once `document.referrer` is
 * readable. Runs once; it never re-reads, so the acknowledgement is stable for the
 * life of the mounted page.
 */
export function useSocialArrival(): SocialPlatform | null {
  const [platform, setPlatform] = useState<SocialPlatform | null>(null);

  useEffect(() => {
    setPlatform(classifySocialReferrer(document.referrer, window.location.origin));
  }, []);

  return platform;
}
