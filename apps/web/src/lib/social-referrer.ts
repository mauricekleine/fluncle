import { useEffect, useState } from "react";

export type SocialPlatform = "bluesky" | "instagram" | "tiktok" | "youtube";

const SOCIAL_DOMAINS: ReadonlyArray<readonly [string, SocialPlatform]> = [
  ["tiktok.com", "tiktok"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["instagram.com", "instagram"],
  ["bsky.app", "bluesky"],
];

const hostMatches = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

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
    return null;
  }

  let currentHost = "";

  try {
    currentHost = new URL(currentOrigin).hostname.toLowerCase();
  } catch {
    currentHost = "";
  }

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

export function useSocialArrival(): SocialPlatform | null {
  const [platform, setPlatform] = useState<SocialPlatform | null>(null);

  useEffect(() => {
    setPlatform(classifySocialReferrer(document.referrer, window.location.origin));
  }, []);

  return platform;
}
