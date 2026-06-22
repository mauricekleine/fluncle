// The Fluncle identity strings (web-overhaul RFC §4, decisions §8.4 +
// 2026-06-11 follow-up).
//
// - fluncleTagline: the one-line opener every register starts from.
// - fluncleDescription: the canonical ENTITY description for machine-facing
//   surfaces — home/root meta, llms.txt, the glossary, WebSite/MusicGroup
//   schema. Reused verbatim; edit it here or nowhere.
export const fluncleTagline = "Drum & bass bangers from another dimension.";

export const fluncleAsciiLogo = `███████╗██╗     ██╗   ██╗███╗   ██╗ ██████╗██╗     ███████╗
██╔════╝██║     ██║   ██║████╗  ██║██╔════╝██║     ██╔════╝
█████╗  ██║     ██║   ██║██╔██╗ ██║██║     ██║     █████╗
██╔══╝  ██║     ██║   ██║██║╚██╗██║██║     ██║     ██╔══╝
██║     ███████╗╚██████╔╝██║ ╚████║╚██████╗███████╗███████╗
╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚══════╝╚══════╝`;

export const fluncleDescription =
  "Drum & bass bangers from another dimension. Fluncle discovers and certifies every track, logs each as a finding, and keeps the full archive across the Galaxy, from the web to the rave terminal. fluncle.com is home base.";

// The ≤155-char version for SERP <meta name="description"> / og / twitter tags.
// The full fluncleDescription above is the canonical ENTITY description (JSON-LD,
// manifest, /about prose) and runs long for a snippet, which Bing/Google flag +
// truncate. This trimmed line is used only in head meta.
export const fluncleMetaDescription =
  "Drum & bass bangers from another dimension. Fluncle discovers, certifies, and logs every find, with the full archive across the Galaxy at fluncle.com.";
