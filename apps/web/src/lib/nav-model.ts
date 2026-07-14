// The one shared navigation model — the single source of truth the public nav reads.
// Add a surface here once and it lights up wherever the nav renders (the same
// registry-driven discipline as @fluncle/registry, scoped to the human nav).
//
// PURE DATA on purpose (no React, no icons, no I/O): the icon mapping lives in the
// rendering layer (components/nav/nav-icons.tsx), the socials keep their brand marks
// there too. Keeping this a plain `.ts` module lets the completeness test read the
// model without pulling in the whole component tree — and lets a crawler-facing
// footer be built from it deterministically.
//
// Fluncle is a GRAPH archive: the log is the trunk (findings ↔ artists ↔ labels ↔ albums
// ↔ galaxies ↔ the logbook). This model is that trunk in nav form; the in-page cross-links
// (the /log prose galaxy + artist links, the album → label uplink) are the branches.
//
// And the trunk forks, which is why the browse sections are TWO and not one. There is what
// Fluncle DID out there — the log, the logbook, the galaxies, the mixtapes: his own objects,
// the markers he left behind him, and you can TRAVEL ALONG them. And there is what he found
// it AMONG — the artists, the albums, the labels: the music's own taxonomy, the stuff printed
// on the sleeve, and you BROWSE it. A flat list of both reads as a sitemap; the fork reads as
// a story.
//
// The four headings are one plain word or phrase each — Travel along / Browse / Listen / Crew
// — and that is the register, not a coincidence. They were "The trail" and "The crates", two
// abstract nouns that named nothing a reader could act on and neither of which is canon; a
// heading in the colophon is a door, so it says what you do when you walk through it.
//
// The architecture is the LOGBOOK COLOPHON (ratified): a minimal top bar carrying
// only the wordmark + a per-page breadcrumb, with the whole nav weight banked in a
// liner-notes footer. The cover stays the hero; the crawl graph still gets its
// links. See the breadcrumb component for why that is not an SEO cost.

import {
  galaxyUrl,
  radioUrl,
  repoUrl,
  spotifyPlaylistUrl,
  blueskyUrl,
  instagramUrl,
  mixcloudUrl,
  soundcloudUrl,
  telegramUrl,
  tiktokUrl,
  twitchUrl,
  xUrl,
  youtubeUrl,
} from "./fluncle-links";

/** A dialog-backed call to action (rendered by the variant, not a hyperlink). */
export type NavAction = "submit" | "subscribe";

/**
 * One navigable target. Three kinds so a variant can render each honestly:
 * - `route`    an internal TanStack `<Link>` (a real same-origin `<a href>`), the
 *              crawl path between indexes;
 * - `external` an off-site `<a target="_blank" rel="noreferrer">` (Spotify, radio,
 *              the socials, the repo);
 * - `action`   a dialog CTA (submit a track, subscribe) — no destination URL.
 */
export type NavItem = {
  /** Stable id: React keys, the icon map, and the completeness test all key off it. */
  id: string;
  /** The link label — sentence case, never uppercase-tracked (DESIGN.md typography). */
  label: string;
  /** A one-line gloss for the roomy surfaces (the drawer, the colophon). Fluncle voice. */
  blurb?: string;
  /**
   * Designed but not yet shipped. Kept in the model so the slot exists and deleting this
   * one flag lights it up the day the route lands — never rendered as a live link
   * meanwhile (no 404s in the nav). Nothing carries it today: the Labels slot it was
   * introduced for went live with the graph surfaces, alongside Albums.
   */
  future?: boolean;
  /**
   * Operator-only (the /mix set-builder is admin-gated). Present for completeness,
   * skipped by every PUBLIC variant via `publicItems()`.
   */
  adminOnly?: boolean;
  /**
   * Gated on a runtime signal resolved client-side (`/galaxies` 404s until the whole
   * sonic map is named). The variant hides it until the gate opens — self-healing.
   */
  gate?: "galaxies";
} & (
  | { kind: "route"; to: string; params?: Record<string, string> }
  | { kind: "external"; href: string }
  | { kind: "action"; action: NavAction }
);

/** A titled group of items (Travel along / Browse / Listen / Crew). */
export type NavSection = {
  id: "browse" | "crew" | "listen" | "travel";
  label: string;
  items: NavItem[];
};

/** An off-site profile in the "Follow Fluncle" row (icon supplied by the renderer). */
export type NavSocial = { id: string; label: string; href: string };

/** A terminal-voiced developer surface in the "For the nerds" row. */
export type NavNerd =
  | { id: string; label: string; kind: "docs"; splat: string }
  | { id: string; label: string; kind: "external"; href: string };

// ── Travel along ────────────────────────────────────────────────────────────────
// What Fluncle DID out there, and the markers he left behind him: every finding he
// logged, the voyage he wrote up, the map of how it all sounds, the nights he dreamt
// back. LORE.md is the licence for the heading — "everything he finds he leaves as a
// trail, and the crew is who follows it" — so the heading is the INVITATION to follow
// it, in his own voice, rather than the abstract noun for it. They exist because he
// went; nothing here would be here if he had stayed home.
const travelItems: NavItem[] = [
  {
    blurb: "Every finding, one coordinate each.",
    id: "log",
    kind: "route",
    label: "Log",
    to: "/log",
  },
  {
    blurb: "The voyage, one entry per sector-day.",
    id: "logbook",
    kind: "route",
    label: "Logbook",
    to: "/logbook",
  },
  {
    blurb: "The archive, grouped by how it hits.",
    gate: "galaxies",
    id: "galaxies",
    kind: "route",
    label: "Galaxies",
    to: "/galaxies",
  },
  {
    blurb: "Long sets. Me, dreaming.",
    id: "mixtapes",
    kind: "route",
    label: "Mixtapes",
    to: "/mixtapes",
  },
  {
    adminOnly: true,
    blurb: "Chain your own set.",
    id: "mix",
    kind: "route",
    label: "Mix",
    to: "/mix",
  },
];

// ── Browse ──────────────────────────────────────────────────────────────────────
// What he found it AMONG: the people who made the bangers, the records they came off,
// the labels that pressed them. Not Fluncle's objects — the music's own, the stuff
// printed on the sleeve. He digs through it; the section above is what he pulled out.
//
// The heading names the ACT, not the shelf, and it is deliberately NOT the internal
// word for this tier — that word never appears in public copy (docs/album-entity.md).
const browseItems: NavItem[] = [
  {
    blurb: "Everyone I've found a banger from.",
    id: "artists",
    kind: "route",
    label: "Artists",
    to: "/artists",
  },
  {
    blurb: "The records I pulled them off.",
    id: "albums",
    kind: "route",
    label: "Albums",
    to: "/albums",
  },
  {
    blurb: "The labels behind the bangers.",
    id: "labels",
    kind: "route",
    label: "Labels",
    to: "/labels",
  },
];

// ── Listen ──────────────────────────────────────────────────────────────────────
const listenItems: NavItem[] = [
  {
    blurb: "The findings on Spotify.",
    href: spotifyPlaylistUrl,
    id: "playlist",
    kind: "external",
    label: "Playlist",
  },
  {
    blurb: "One synchronized run of the log.",
    href: radioUrl,
    id: "radio",
    kind: "external",
    label: "Radio",
  },
];

// ── Crew ────────────────────────────────────────────────────────────────────────
const crewItems: NavItem[] = [
  {
    blurb: "What a Log ID is, and who's logging.",
    id: "about",
    kind: "route",
    label: "About",
    to: "/about",
  },
  {
    blurb: "How many of you are aboard, and how far it's carried.",
    id: "reach",
    kind: "route",
    label: "Reach",
    to: "/reach",
  },
  {
    blurb: "The week's findings, in your inbox.",
    id: "newsletter",
    kind: "route",
    label: "Newsletter",
    to: "/newsletter",
  },
  {
    blurb: "How the machinery works, if you're curious.",
    id: "docs",
    kind: "route",
    label: "Docs",
    to: "/docs",
  },
  {
    action: "submit",
    blurb: "Heard something? Send it my way.",
    id: "submit",
    kind: "action",
    label: "Submit a track",
  },
];

// The order is the story: what he did, what he found it among, how to hear it, who it is
// for. The voyage leads because the findings are the product.
export const navSections: NavSection[] = [
  { id: "travel", items: travelItems, label: "Travel along" },
  { id: "browse", items: browseItems, label: "Browse" },
  { id: "listen", items: listenItems, label: "Listen" },
  { id: "crew", items: crewItems, label: "Crew" },
];

// Fluncle off-site, alphabetical (docs/socials/). Spotify is the Playlist link in
// Listen, so it stays out of the icon strip to avoid a duplicate.
export const navFollow: NavSocial[] = [
  { href: blueskyUrl, id: "bluesky", label: "Fluncle on Bluesky" },
  { href: instagramUrl, id: "instagram", label: "Fluncle on Instagram" },
  { href: mixcloudUrl, id: "mixcloud", label: "Fluncle on Mixcloud" },
  { href: soundcloudUrl, id: "soundcloud", label: "Fluncle on SoundCloud" },
  { href: telegramUrl, id: "telegram", label: "Fluncle on Telegram" },
  { href: tiktokUrl, id: "tiktok", label: "Fluncle on TikTok" },
  { href: twitchUrl, id: "twitch", label: "Fluncle on Twitch" },
  { href: xUrl, id: "x", label: "DM me on X" },
  { href: youtubeUrl, id: "youtube", label: "Fluncle on YouTube" },
];

// The terminal surfaces (DESIGN.md mono voice): the CLI/DIG/MCP/SSH docs pages plus
// the open-source repo. Docs pages route through the /docs/$ splat.
export const navNerds: NavNerd[] = [
  { id: "cli", kind: "docs", label: "CLI", splat: "cli" },
  { id: "dig", kind: "docs", label: "DIG", splat: "dig" },
  { href: repoUrl, id: "git", kind: "external", label: "GIT" },
  { id: "mcp", kind: "docs", label: "MCP", splat: "mcp" },
  { id: "ssh", kind: "docs", label: "SSH", splat: "ssh" },
];

// The two identity CTAs. Both live on the HOME page (the Galaxy gold button is the
// ONE sun — DESIGN.md One Sun — and never belongs in the quiet colophon); kept here
// so the model still owns every route the nav can reach, for the completeness test.
export const navPrimaryCta = {
  galaxy: { href: galaxyUrl, id: "galaxy", label: "Enter Fluncle's Galaxy" },
  joinCrew: { id: "join-crew", label: "Join the crew", to: "/account" },
} as const;

/**
 * The public subset of a section's items: drops the admin-only ones (the /mix
 * builder). Future items are KEPT here (a variant renders them as a disabled
 * "soon" slot); the galaxies gate is applied by the renderer, which has the
 * runtime signal.
 */
export function publicItems(section: NavSection): NavItem[] {
  return section.items.filter((item) => !item.adminOnly);
}

/**
 * The items a PUBLIC variant should actually render for a section: drops admin-only
 * items, and drops the galaxies-gated item until its runtime gate opens. Future
 * items are kept (rendered as a disabled "soon" slot).
 */
export function renderableItems(section: NavSection, galaxiesLive: boolean): NavItem[] {
  return publicItems(section).filter((item) => item.gate !== "galaxies" || galaxiesLive);
}

/** Every internal route path the model points at (for the completeness test). */
export function navRoutePaths(): string[] {
  return navSections
    .flatMap((section) => section.items)
    .flatMap((item) => (item.kind === "route" ? [item.to] : []))
    .concat(navPrimaryCta.joinCrew.to);
}
