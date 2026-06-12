import { fluncleAsciiLogo, fluncleTagline } from "../brand";

type Link = {
  label: string;
  url: string;
};

type LinkGroup = {
  heading: string;
  links: Link[];
};

/**
 * The canonical link map (docs/socials/). Grouped the way the crew reaches for
 * them: where to listen, where to follow, the mothership, and the nerdier
 * corners. URLs are verbatim — the handle is lowercase `fluncle` everywhere
 * (VOICE.md §6).
 */
export const linkGroups: LinkGroup[] = [
  {
    heading: "Where to listen",
    links: [
      {
        label: "Spotify — Fluncle's Findings",
        url: "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0",
      },
      { label: "Mixcloud", url: "https://www.mixcloud.com/fluncle/" },
      { label: "YouTube", url: "https://www.youtube.com/@fluncle" },
    ],
  },
  {
    heading: "Follow the crew",
    links: [
      { label: "TikTok", url: "https://www.tiktok.com/@fluncle" },
      { label: "Instagram", url: "https://www.instagram.com/fluncle/" },
      { label: "Telegram", url: "https://t.me/fluncle" },
    ],
  },
  {
    heading: "The mothership",
    links: [
      { label: "Web — the archive", url: "https://www.fluncle.com" },
      { label: "Newsletter", url: "Fresh bangers, every Friday — sign up at www.fluncle.com" },
      { label: "RSS — the feed", url: "https://www.fluncle.com/rss.xml" },
    ],
  },
  {
    heading: "For the nerds",
    links: [
      { label: "The Galaxy (game)", url: "https://galaxy.fluncle.com" },
      { label: "SSH (this terminal)", url: "ssh rave.fluncle.com" },
      { label: "Source", url: "https://github.com/mauricekleine/fluncle" },
    ],
  },
];

/**
 * `fluncle about` — Fluncle introduces himself and points at where to find him
 * across the Galaxy. Read-only, no network, no auth: the wordmark, a short
 * first-person line (the About surface is one of the long-form registers where
 * the cosmos may drive the verb, per VOICE.md's Garnish Rule), then the links
 * grouped the way the crew uses them. Typographically clean — no emoji (CLI
 * register).
 */
export function aboutLines(): string[] {
  const lines: string[] = [
    "",
    fluncleAsciiLogo,
    "",
    fluncleTagline,
    "",
    "I'm Fluncle. Been digging since '90, only now I do it across the Galaxy — every banger I",
    "find gets logged and sent back. Here's where the findings land, and where the crew gathers.",
  ];

  for (const group of linkGroups) {
    const labelWidth = group.links.reduce((width, link) => {
      return Math.max(width, link.label.length);
    }, 0);

    lines.push("", `${group.heading}:`);

    for (const link of group.links) {
      lines.push(`  ${link.label.padEnd(labelWidth)}  ${link.url}`);
    }
  }

  return lines;
}

export function aboutCommand(): void {
  console.log(aboutLines().join("\n"));
}
