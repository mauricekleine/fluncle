// The Fluncle identity strings (web-overhaul RFC §4, decisions §8.4 +
// 2026-06-11 follow-up). Two registers, one opener:
//
// - fluncleDescription: the canonical ENTITY description for machine-facing
//   surfaces — home/root meta, llms.txt, the glossary, WebSite/MusicGroup
//   schema. Reused verbatim; edit it here or nowhere.
// - fluncleBio: the PLATFORM bio (Spotify, Telegram, TikTok, MusicBrainz,
//   Wikidata, …) — the tagline plus the address, set by Maurice on every
//   platform. Kept here so the convention is written down; the platforms
//   themselves are updated by hand (docs/socials.md is the map).
//
// Both open with the tagline, so the entity reads identically everywhere.
export const fluncleTagline = "Drum & bass bangers from another dimension.";

export const fluncleDescription =
  "Drum & bass bangers from another dimension. Fluncle digs and certifies every track, publishes them to Spotify and Telegram, and keeps the full archive of his findings at fluncle.com.";

export const fluncleBio = `${fluncleTagline}

www.fluncle.com`;
