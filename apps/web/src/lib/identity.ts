// The Fluncle identity strings (web-overhaul RFC §4, decisions §8.4).
//
// - fluncleDescription: the canonical ENTITY description for machine-facing
//   surfaces — home/root meta, llms.txt, the glossary, WebSite/MusicGroup
//   schema. Reused verbatim; edit it here or nowhere.
export const fluncleAsciiLogo = `███████╗██╗     ██╗   ██╗███╗   ██╗ ██████╗██╗     ███████╗
██╔════╝██║     ██║   ██║████╗  ██║██╔════╝██║     ██╔════╝
█████╗  ██║     ██║   ██║██╔██╗ ██║██║     ██║     █████╗
██╔══╝  ██║     ██║   ██║██║╚██╗██║██║     ██║     ██╔══╝
██║     ███████╗╚██████╔╝██║ ╚████║╚██████╗███████╗███████╗
╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚══════╝╚══════╝`;

/**
 * The TAGLINE — the shortest form of the entity, and the line both identity strings
 * below open with. It is spelled out by hand on twenty-odd surfaces that cannot all
 * import it (a Go terminal, a Homebrew formula, three static assets, four escaped-HTML
 * renders), so the constant is the NAME of the string rather than its only copy:
 * `identity.test.ts` scans the repo for it and pins every site to this spelling.
 */
export const fluncleTagline = "Drum & bass bangers from another dimension";

export const fluncleDescription =
  "Drum & bass bangers from another dimension. Fluncle discovers and certifies every track, logs each as a finding, and keeps the full archive across the Galaxy, from the web to the rave terminal. fluncle.com is home base.";

// The ≤155-char version for SERP <meta name="description"> / og / twitter tags.
// The full fluncleDescription above is the canonical ENTITY description (JSON-LD,
// manifest, /about prose) and runs long for a snippet, which Bing/Google flag +
// truncate. This trimmed line is used only in head meta.
export const fluncleMetaDescription =
  "Drum & bass bangers from another dimension. Fluncle discovers, certifies, and logs every find, with the full archive across the Galaxy at fluncle.com.";
