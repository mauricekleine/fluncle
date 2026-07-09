import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "../fluncle-links";
import { fluncleDescription } from "../identity";
import { type FeedItem } from "../mixtapes";
import { sha256Hex } from "./hash";
import { type TrackCursor, type TrackListItem, decodeTrackCursor, listTracks } from "./tracks";

// Agent-facing discovery surfaces served ahead of the TanStack router:
// the RFC 9727 API catalog, the Agent Skills Discovery index, a text/markdown
// rendering of the homepage for Accept-negotiating agents (the router's SSR
// handler otherwise 500s on non-HTML Accept headers), and llms-full.txt — the
// entire archive as one ingestible document.

const markdownTracksLimit = 25;

// llms-full.txt page size and a runaway backstop; if the archive ever exceeds
// the cap we render up to it and say so (never a silent truncation).
const llmsFullPageSize = 100;
const llmsFullMaxFindings = 2000;

// RFC 8288 Link header advertised on the homepage so agents can find the
// machine-readable surfaces without guessing well-known paths.
const agentLinkHeader = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"',
  '</llms.txt>; rel="service-doc"; type="text/markdown"',
  '</llms-full.txt>; rel="service-doc"; type="text/markdown"',
  '</rss.xml>; rel="alternate"; type="application/rss+xml"',
].join(", ");

export function appendAgentLinkHeaders(response: Response): Response {
  // Worker responses arrive with immutable headers; re-wrap to mutate.
  const linked = new Response(response.body, response);
  linked.headers.append("Link", agentLinkHeader);
  linked.headers.append("Vary", "Accept");

  return linked;
}

// The web onion's v3 hostname (without scheme or the trailing `.onion`). This is
// the live address minted by the onionspray mirror on the public-edge box;
// setting it and pushing is the whole of the onion go-live. Once set,
// appendOnionLocation advertises the onion twin on every
// HTML response. The private key is custodied in the configured 1Password item
// (see the ops runbook note).
const WEB_ONION_HOSTNAME = "p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd";

// Advertise the onion twin via the Onion-Location response header (Tor Browser
// desktop shows a ".onion available" pill that one-clicks to the mirror). Unlike
// the homepage-only Link header, this is per-path: a Tor user on /log/<id> lands
// on that finding's onion page. The hostname is a parameter so tests can exercise
// the "set" state without a real address baked into source; production passes the
// module constant. Gated to text/html responses — the pill does nothing on the
// JSON/XML surfaces (/api/v1/*, /rss.xml, /mcp), where the header would be noise.
export function appendOnionLocation(
  response: Response,
  url: URL,
  onionHostname: string = WEB_ONION_HOSTNAME,
): Response {
  if (onionHostname === "") {
    return response;
  }

  if (!(response.headers.get("content-type")?.includes("text/html") ?? false)) {
    return response;
  }

  // Worker responses arrive with immutable headers; re-wrap to mutate.
  const located = new Response(response.body, response);
  located.headers.set(
    "Onion-Location",
    `http://${onionHostname}.onion${url.pathname}${url.search}`,
  );

  return located;
}

export async function handleAgentDiscovery(request: Request): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }

  const url = new URL(request.url);

  switch (url.pathname) {
    case "/.well-known/api-catalog":
      return apiCatalogResponse();
    case "/.well-known/agent-skills/index.json":
      return skillsIndexResponse();
    case "/.well-known/agent-skills/fluncle-api/SKILL.md":
      return skillResponse();
    case "/llms-full.txt":
      return llmsFullResponse();
    case "/":
      return prefersMarkdown(request) ? markdownHomeResponse() : undefined;
    default:
      return undefined;
  }
}

function prefersMarkdown(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/markdown") ?? false;
}

// RFC 9727: linkset (RFC 9264) describing the public API.
function apiCatalogResponse(): Response {
  const catalog = {
    linkset: [
      {
        anchor: `${siteUrl}/api/v1`,
        "service-desc": [
          {
            href: `${siteUrl}/api/v1/openapi.json`,
            type: "application/openapi+json",
          },
        ],
        "service-doc": [
          {
            href: `${siteUrl}/llms.txt`,
            type: "text/markdown",
          },
        ],
        status: [
          {
            href: `${siteUrl}/api/v1/health`,
          },
        ],
      },
    ],
  };

  return new Response(JSON.stringify(catalog, null, 2), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/linkset+json",
    },
  });
}

// Agent Skills Discovery RFC v0.2.0 index. The digest is computed from the
// served SKILL.md bytes at runtime so the two can never drift.
async function skillsIndexResponse(): Promise<Response> {
  const index = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        description:
          "Read and contribute to Fluncle's drum & bass archive over the public HTTP API: list certified tracks, pull a random one, search Spotify candidates, and submit tracks for Fluncle to review.",
        digest: await skillDigest(),
        name: "fluncle-api",
        type: "skill-md",
        url: `${siteUrl}/.well-known/agent-skills/fluncle-api/SKILL.md`,
      },
    ],
  };

  return new Response(JSON.stringify(index, null, 2), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}

function skillResponse(): Response {
  return new Response(skillMarkdown, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

let cachedSkillDigest: string | undefined;

async function skillDigest(): Promise<string> {
  if (!cachedSkillDigest) {
    const hex = await sha256Hex(new TextEncoder().encode(skillMarkdown));

    cachedSkillDigest = `sha256:${hex}`;
  }

  return cachedSkillDigest;
}

async function markdownHomeResponse(): Promise<Response> {
  const page = await listTracks({ includeMixtapes: true, limit: markdownTracksLimit });
  const tracks = page.tracks.map((track) => {
    if (track.type === "mixtape") {
      return `- ${track.title} (${track.logId ?? "draft checkpoint"})`;
    }

    return `- ${track.artists.join(", ")} — ${track.title} (found ${track.addedAt.slice(0, 10)})`;
  });

  const markdown = `# Fluncle

> ${fluncleDescription}

One selector, no team, digging drum & bass since '90. Dates mark when he found it: the day Fluncle first heard the tune, not the day it released. The collection is called Fluncle's Findings; the archive holds ${page.totalCount} certified tracks, and new ones land most nights.

## Latest findings

${tracks.join("\n")}

## Listen

- [Fluncle's Findings on Spotify](${spotifyPlaylistUrl}): the playlist itself
- [Fluncle on Telegram](${telegramUrl}): one banger per post, most nights
- [The archive](${siteUrl}/): every certified track with the date Fluncle found it

## Data

- [RSS feed](${siteUrl}/rss.xml): the 25 most recent tracks
- [Tracks API](${siteUrl}/api/v1/tracks): the archive as JSON, cursor-paginated; accepts limit (max 48) and cursor query params
- [Random track](${siteUrl}/api/v1/tracks/random): one pick from the archive, as JSON
- [Artists API](${siteUrl}/api/v1/artists): every artist with a published finding, most findings first, as JSON; /api/v1/artists/{slug} for one artist. Each resolves to a page at ${siteUrl}/artist/{slug} — that artist's findings plus their verified identity links (MusicGroup + sameAs)
- [Mixtapes API](${siteUrl}/api/v1/mixtapes): Fluncle's own DJ mixtapes as JSON — each a checkpoint set with an F-marked Log ID and its tracklist; browse them at ${siteUrl}/mixtapes

## Submit

- [Search API](${siteUrl}/api/v1/search): GET with a q query param (a track search or Spotify URL), returns candidates as JSON
- [Submissions API](${siteUrl}/api/v1/submissions): POST a candidate for review; Fluncle gives it a listen before anything publishes

## For agents

- [OpenAPI spec](${siteUrl}/api/v1/openapi.json): the public API as an OpenAPI 3.1 document
- [MCP server](${siteUrl}/mcp): the same archive as Model Context Protocol tools (Streamable HTTP, no auth)
- [MCP server card](${siteUrl}/.well-known/mcp/server-card.json): SEP-2127 discovery card for the MCP endpoint
- [API catalog](${siteUrl}/.well-known/api-catalog): RFC 9727 linkset
- [Agent skills](${siteUrl}/.well-known/agent-skills/index.json): the fluncle-api skill, with digest
- [llms.txt](${siteUrl}/llms.txt): the plain-language map of the Galaxy
- [llms-full.txt](${siteUrl}/llms-full.txt): the entire archive in one document, every finding

## Tools

- [CLI installer](${siteUrl}/cli/latest.sh): curl -fsSL ${siteUrl}/cli/latest.sh | sh, then try fluncle recent
- [Fluncle Lens](https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk): a Chrome extension that finds fluncle:// coordinates on any web page and links each to its /log finding
- The rave terminal: ssh rave.fluncle.com, the deep end of the Galaxy
`;

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: agentLinkHeader,
      Vary: "Accept",
      "x-markdown-tokens": String(Math.ceil(markdown.length / 4)),
    },
  });
}

// /llms-full.txt: the entire archive as one ingestible markdown document — the
// lore plus every finding (coordinate, found date, BPM/key/galaxy, Spotify),
// so an LLM can read the whole archive in a single fetch. Pure renderer,
// exported for tests; the response wraps it.
export function renderLlmsFull(tracks: FeedItem[], totalCount: number): string {
  const findings = tracks
    .map((track) => (track.type === "mixtape" ? renderMixtape(track) : renderFinding(track)))
    .join("\n");
  const omitted = totalCount - tracks.length;

  return `# Fluncle: the full archive

> ${fluncleDescription}

Fluncle is a single drum & bass selector, not a team: drum & bass end to end, rollers to jungle to neurofunk. Every finding below is a track he found, heard in full, and certified. Dates mark when he found it: the day Fluncle first heard the tune, not the day it released. The collection is Fluncle's Findings.

## How to read a Log ID

Every finding has a permanent coordinate, a Log ID, written sector.orbit.mark, for example 004.7.2I, full form fluncle://004.7.2I. The sector counts the days from the epoch (2026-05-30) to the day Fluncle found the tune; the tail is a stable signature derived from the recording itself. Each one is minted once, never reassigned, and resolves to a log page at ${siteUrl}/log/<id>.

## The findings (${totalCount})

${findings}
${omitted > 0 ? `\n_${omitted} older findings omitted here; page the rest at ${siteUrl}/api/v1/tracks._\n` : ""}
## More

- The map: ${siteUrl}/llms.txt
- The playlist: ${spotifyPlaylistUrl}
- The Telegram feed: ${telegramUrl}
- The JSON API: ${siteUrl}/api/v1/tracks
- The artists: ${siteUrl}/api/v1/artists
- The mixtapes: ${siteUrl}/api/v1/mixtapes
- The MCP server: ${siteUrl}/mcp
`;
}

// One finding: the coordinate-led header, then the dry facts (present fields
// only).
function renderFinding(track: TrackListItem): string {
  const coordinate = track.logId ? `fluncle://${track.logId}` : "uncoordinated";
  const lines = [
    `- **${track.artists.join(", ")} — ${track.title}** (found ${track.addedAt.slice(0, 10)}, ${coordinate})`,
  ];

  const facts: string[] = [];

  if (track.bpm) {
    facts.push(`${Math.round(track.bpm)} BPM`);
  }

  if (track.key) {
    facts.push(track.key);
  }

  if (track.galaxy) {
    facts.push(`${track.galaxy.name} galaxy`);
  }

  facts.push(track.spotifyUrl);
  lines.push(`  ${facts.join(" · ")}`);

  return lines.join("\n");
}

function renderMixtape(track: Extract<FeedItem, { type: "mixtape" }>): string {
  const coordinate = track.logId ? `fluncle://${track.logId}` : "uncoordinated";
  const facts = [
    `${track.memberCount} ${track.memberCount === 1 ? "finding" : "findings"}`,
    track.externalUrls.mixcloud ?? track.externalUrls.youtube ?? track.externalUrls.soundcloud,
  ].filter(Boolean);

  return [`- **${track.title}** (${coordinate})`, `  ${facts.join(" · ")}`].join("\n");
}

async function llmsFullResponse(): Promise<Response> {
  const all: FeedItem[] = [];
  let cursor: TrackCursor | undefined;
  let totalCount = 0;

  do {
    const page = await listTracks({ cursor, includeMixtapes: true, limit: llmsFullPageSize });
    totalCount = page.totalCount;
    all.push(...page.tracks);
    cursor = page.nextCursor ? decodeTrackCursor(page.nextCursor) : undefined;
  } while (cursor && all.length < llmsFullMaxFindings);

  const markdown = renderLlmsFull(all, totalCount);

  return new Response(markdown, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/markdown; charset=utf-8",
      Link: agentLinkHeader,
      Vary: "Accept",
      "x-markdown-tokens": String(Math.ceil(markdown.length / 4)),
    },
  });
}

// Served at /.well-known/agent-skills/fluncle-api/SKILL.md. Lives here as a
// constant so the index digest above always matches the served bytes.
const skillMarkdown = `---
name: fluncle-api
description: Read and contribute to Fluncle's drum & bass archive over the public HTTP API. List certified tracks, pull a random one, search Spotify candidates, and submit tracks for Fluncle to review.
---

# Fluncle API

Fluncle discovers and certifies drum & bass bangers, logs each as a finding, and keeps the full archive across the Galaxy, with ${siteUrl} as home base. One selector, no team. Dates mark when he found it: the day Fluncle first heard the tune, not the day it released.

Base URL: \`${siteUrl}\`. Everything below returns JSON. Errors look like \`{"ok": false, "code": "...", "message": "..."}\`.

## Read the archive

- \`GET /api/v1/tracks\` lists certified tracks, newest found first. Query params: \`limit\` (1 to 48, default 16), \`cursor\` (opaque, from \`nextCursor\`), \`since\` and \`until\` (ISO 8601 bounds on the date found). Response: \`{"tracks": [...], "totalCount": n, "nextCursor": "..."}\`. Page until \`nextCursor\` disappears.
- \`GET /api/v1/tracks/random\` returns one pick from the archive: \`{"ok": true, "track": {...}}\`.

Track objects carry \`trackId\`, \`title\`, \`artists\`, \`album\`, \`albumImageUrl\`, \`note\`, \`spotifyUrl\`, \`addedAt\` (the timestamp it was found), \`addedToSpotify\`, and \`postedToTelegram\`. The \`note\` is Fluncle's own line about the tune; quote it as his.

## Submit a track

Two steps. Fluncle listens before anything publishes; a submission is a recommendation, not a write.

1. \`GET /api/v1/search?q=...\` with a track name or a Spotify track URL (minimum 2 characters). Returns \`{"ok": true, "results": [...]}\` where each candidate has \`id\`, \`spotifyUrl\`, \`title\`, \`artists\`, \`album\`, and \`artworkUrl\`.
2. \`POST /api/v1/submissions\` with a JSON body: \`spotifyTrackId\` and \`spotifyUrl\` (both from the chosen candidate; they must agree), \`title\`, \`artists\` (string array), \`source\` (one of "web", "cli", "ssh"), plus optional \`note\` (max 500 characters, tell Fluncle why it's a banger) and \`contact\` (max 120 characters). Response: \`{"ok": true, "submission": {...}}\` with \`status: "pending"\`.

Rate limit: 5 submissions per connection per hour. Over that returns 429 with code \`rate_limited\`.

## Board the mothership

\`POST /api/v1/newsletter\` with \`{"email": "..."}\` subscribes to the newsletter. Fresh bangers, every Friday, from Fluncle.

## Model Context Protocol

The same tools are available over MCP (Streamable HTTP, no auth) at \`${siteUrl}/mcp\`: \`list_tracks\`, \`get_random_track\`, \`search_tracks\`, \`submit_track\`, and \`subscribe_newsletter\`. The server card (SEP-2127) is at \`${siteUrl}/.well-known/mcp/server-card.json\`.

## Everything else

- \`GET /rss.xml\`: the 25 most recent findings as RSS.
- \`GET /llms.txt\`: the plain-language map of the Galaxy.
- \`GET /api/v1/openapi.json\`: this API as an OpenAPI 3.1 document.
- \`GET /api/v1/health\`: liveness, \`{"ok": true}\`.
- \`ssh rave.fluncle.com\`: the rave terminal, the deep end of the Galaxy. Bring a TTY.
`;
