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

export type NavAction = "submit" | "subscribe";

export type NavItem = {
  id: string;

  label: string;

  blurb?: string;

  future?: boolean;

  adminOnly?: boolean;

  gate?: "galaxies";
} & (
  | { kind: "route"; to: string; params?: Record<string, string> }
  | { kind: "external"; href: string }
  | { kind: "action"; action: NavAction }
);

export type NavSection = {
  id: "browse" | "crew" | "listen" | "travel";
  label: string;
  items: NavItem[];
};

export type NavSocial = { id: string; label: string; href: string };

export type NavNerd =
  | { id: string; label: string; kind: "docs"; splat: string }
  | { id: string; label: string; kind: "external"; href: string };

const travelItems: NavItem[] = [
  {
    blurb: "Every banger I've certified, newest first.",
    id: "findings",
    kind: "route",
    label: "Findings",
    to: "/findings",
  },
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

const browseItems: NavItem[] = [
  {
    blurb: "One box over everything I hold.",
    id: "search",
    kind: "route",
    label: "Search",
    to: "/search",
  },
  {
    blurb: "Every track I hold, the whole crate.",
    id: "tracks",
    kind: "route",
    label: "Tracks",
    to: "/tracks",
  },
  {
    blurb: "Everyone who made something in here.",
    id: "artists",
    kind: "route",
    label: "Artists",
    to: "/artists",
  },
  {
    blurb: "Every record a track in here came off.",
    id: "albums",
    kind: "route",
    label: "Albums",
    to: "/albums",
  },
  {
    blurb: "Every label that pressed a record in here.",
    id: "labels",
    kind: "route",
    label: "Labels",
    to: "/labels",
  },
  {
    blurb: "What just came out, freshest first.",
    id: "fresh",
    kind: "route",
    label: "Fresh",
    to: "/fresh",
  },
];

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
    blurb: "Follow a banger through every machine, end to end.",
    id: "pipeline",
    kind: "route",
    label: "Pipeline",
    to: "/pipeline",
  },
  {
    action: "submit",
    blurb: "Heard something? Send it my way.",
    id: "submit",
    kind: "action",
    label: "Submit a track",
  },
];

export const navBrowseHubs: NavItem[] = browseItems.filter((item) => item.id !== "search");

export const navSections: NavSection[] = [
  { id: "travel", items: travelItems, label: "Travel along" },
  { id: "browse", items: browseItems, label: "Browse" },
  { id: "listen", items: listenItems, label: "Listen" },
  { id: "crew", items: crewItems, label: "Crew" },
];

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

export const navNerds: NavNerd[] = [
  { id: "cli", kind: "docs", label: "CLI", splat: "cli" },
  { id: "dig", kind: "docs", label: "DIG", splat: "dig" },
  { href: repoUrl, id: "git", kind: "external", label: "GIT" },
  { id: "mcp", kind: "docs", label: "MCP", splat: "mcp" },
  { id: "ssh", kind: "docs", label: "SSH", splat: "ssh" },
];

export const navPrimaryCta = {
  galaxy: { href: galaxyUrl, id: "galaxy", label: "Enter Fluncle's Galaxy" },
  joinCrew: { id: "join-crew", label: "Your account", to: "/account" },
} as const;

export function publicItems(section: NavSection): NavItem[] {
  return section.items.filter((item) => !item.adminOnly);
}

export function renderableItems(section: NavSection, galaxiesLive: boolean): NavItem[] {
  return publicItems(section).filter((item) => item.gate !== "galaxies" || galaxiesLive);
}

export function navRoutePaths(): string[] {
  return navSections
    .flatMap((section) => section.items)
    .flatMap((item) => (item.kind === "route" ? [item.to] : []))
    .concat(navPrimaryCta.joinCrew.to);
}
