// The Fluncle identity strings (web-overhaul RFC §4, decisions §8.4 +
// 2026-06-11 follow-up). Two registers, one opener:
//
// - fluncleDescription: the canonical ENTITY description for machine-facing
//   surfaces — home/root meta, llms.txt, the glossary, WebSite/MusicGroup
//   schema. Reused verbatim; edit it here or nowhere.
// - fluncleBio: the PLATFORM bio (Spotify, Telegram, TikTok, MusicBrainz,
//   Wikidata, …) — the tagline plus the address, set by Maurice on every
//   platform. Kept here so the convention is written down; the platforms
//   themselves are updated by hand (docs/socials/ is the map).
//
// Both open with the tagline, so the entity reads identically everywhere.
export const fluncleTagline = "Drum & bass bangers from another dimension.";

export const fluncleAsciiLogo = `███████╗██╗     ██╗   ██╗███╗   ██╗ ██████╗██╗     ███████╗
██╔════╝██║     ██║   ██║████╗  ██║██╔════╝██║     ██╔════╝
█████╗  ██║     ██║   ██║██╔██╗ ██║██║     ██║     █████╗
██╔══╝  ██║     ██║   ██║██║╚██╗██║██║     ██║     ██╔══╝
██║     ███████╗╚██████╔╝██║ ╚████║╚██████╗███████╗███████╗
╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚══════╝╚══════╝`;

export const fluncleDescription =
  "Drum & bass bangers from another dimension. Fluncle digs and certifies every track, publishes them to Spotify and Telegram, and keeps the full archive of his findings at fluncle.com.";

// The ≤155-char version for SERP <meta name="description"> / og / twitter tags.
// The full fluncleDescription above is the canonical ENTITY description (JSON-LD,
// manifest, /about prose) and runs long for a snippet, which Bing/Google flag +
// truncate. This trimmed line is used only in head meta.
export const fluncleMetaDescription =
  "Drum & bass bangers from another dimension — Fluncle digs, certifies, and publishes each find to Spotify & Telegram. Full archive at fluncle.com.";

export const fluncleBio = `${fluncleTagline}

www.fluncle.com`;
