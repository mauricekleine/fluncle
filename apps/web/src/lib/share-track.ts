import { siteUrl } from "./fluncle-links";

export type ShareMode = "copy" | "native";

export type ShareOutcome = "copied" | "dismissed" | "failed" | "shared";

function withoutQuery(url: URL): string {
  url.search = "";
  url.hash = "";

  return url.toString();
}

export function canonicalShareUrl(track: {
  href?: string;
  spotifyUrl?: string;
}): string | undefined {
  if (track.href?.startsWith("/")) {
    return withoutQuery(new URL(track.href, siteUrl));
  }

  if (track.spotifyUrl) {
    try {
      return withoutQuery(new URL(track.spotifyUrl));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function shareMode(env: { canShare: boolean; coarsePointer: boolean }): ShareMode {
  return env.coarsePointer && env.canShare ? "native" : "copy";
}

function currentShareMode(): ShareMode {
  const coarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return shareMode({ canShare, coarsePointer });
}

async function copyLink(url: string): Promise<ShareOutcome> {
  try {
    await navigator.clipboard.writeText(url);

    return "copied";
  } catch {
    return "failed";
  }
}

export async function shareLink(title: string, url: string): Promise<ShareOutcome> {
  if (currentShareMode() === "copy") {
    return copyLink(url);
  }

  try {
    await navigator.share({ title, url });

    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "dismissed";
    }

    return copyLink(url);
  }
}
