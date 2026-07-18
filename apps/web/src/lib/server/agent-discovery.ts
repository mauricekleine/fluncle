// The static map lives at public/llms.txt (a single source of truth). Cloudflare
// serves that file as text/plain, but it is advertised as text/markdown (the Link
// header + the api-catalog), so we intercept /llms.txt here and re-serve the SAME
// bytes with the correct content-type — mirroring llms-full.txt, which already does.
import llmsTxt from "../../../public/llms.txt?raw";
import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "../fluncle-links";
import { findingsCount } from "../format";
import { fluncleDescription } from "../identity";
import { type FeedItem } from "../mixtapes";
import { isGalaxyMapFullyNamed } from "./galaxies-map";
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
    case "/llms.txt":
      return llmsTxtResponse();
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
  const page = await listTracks({ includeMixtapes: true, lean: true, limit: markdownTracksLimit });
  // The browse-by-feel launch gate (decision 5): the galaxies lens + API stay dark on
  // every public surface — this map included — until the operator has NAMED the whole
  // sonic map, so agents are never pointed at a lens that 404s. Once named, the line
  // lights up here the same moment it does everywhere else.
  const galaxiesLive = await isGalaxyMapFullyNamed();
  const galaxiesLine = galaxiesLive
    ? `\n- [Galaxies API](${siteUrl}/api/v1/galaxies): the archive grouped into operator-named sonic galaxies (clusters over the audio-embedding space), each with its member count, as JSON; /api/v1/galaxies/{slug} for one galaxy's findings core-first. Browse them at ${siteUrl}/galaxies`
    : "";
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
- [Artists API](${siteUrl}/api/v1/artists): every artist with a published finding, most findings first, as JSON; /api/v1/artists/{slug} for one artist. Each resolves to a page at ${siteUrl}/artist/{slug}: that artist's findings plus their verified identity links (MusicGroup + sameAs)
- [Mixtapes API](${siteUrl}/api/v1/mixtapes): Fluncle's own DJ mixtapes as JSON, each a checkpoint set with an F-marked Log ID and its tracklist; browse them at ${siteUrl}/mixtapes${galaxiesLine}
- [The artists](${siteUrl}/artists): every artist Fluncle has found a banger from. Each resolves to a page at ${siteUrl}/artist/{slug}: that artist's findings and their verified identity links
- [The labels](${siteUrl}/labels): every record label Fluncle has found a banger on. Each resolves to a page at ${siteUrl}/label/{slug}: that label's findings, the artists on it, and the rest of its catalogue
- [The albums](${siteUrl}/albums): every record Fluncle has found a banger on. Each resolves to a page at ${siteUrl}/album/{slug}: that record's findings, its artists, and the label it came out on
- [What just came out](${siteUrl}/fresh): the newest drum & bass across the whole archive, freshest first. Every release from the last 30 days, ordered by when it came out (not by when Fluncle found it)

## Submit

- [Search API](${siteUrl}/api/v1/search): GET with a q query param (a track search or Spotify URL), returns candidates as JSON
- [Submissions API](${siteUrl}/api/v1/submissions): POST a candidate for review; Fluncle gives it a listen before anything publishes

## For agents

- [OpenAPI spec](${siteUrl}/api/v1/openapi.json): the public API as an OpenAPI 3.1 document
- [MCP server](${siteUrl}/mcp): the archive over Model Context Protocol (Streamable HTTP, no auth), tools, resources (each finding at fluncle://finding/<logId>), and Fluncle-voiced prompts
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
export function renderLlmsFull(
  tracks: FeedItem[],
  totalCount: number,
  galaxiesLive = false,
): string {
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
- The artists: ${siteUrl}/artists
- The labels: ${siteUrl}/labels
- The albums: ${siteUrl}/albums
- What just came out: ${siteUrl}/fresh
- The mixtapes: ${siteUrl}/api/v1/mixtapes${galaxiesLive ? `\n- The sonic galaxies: ${siteUrl}/api/v1/galaxies` : ""}
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

  // The graph edges carried on the finding itself (album + label slugs load in the
  // same select), rendered as their entity-page URLs so an agent can walk the graph
  // without a second fetch. The artist edge has no slug on the list DTO (artists are
  // a name array here), so it is not linkable from this row — the /artists hub above
  // is the entry point for that leg.
  const graph: string[] = [];

  if (track.labelSlug) {
    graph.push(`label ${siteUrl}/label/${track.labelSlug}`);
  }

  if (track.albumSlug) {
    graph.push(`album ${siteUrl}/album/${track.albumSlug}`);
  }

  if (graph.length > 0) {
    lines.push(`  ${graph.join(" · ")}`);
  }

  return lines.join("\n");
}

function renderMixtape(track: Extract<FeedItem, { type: "mixtape" }>): string {
  const coordinate = track.logId ? `fluncle://${track.logId}` : "uncoordinated";
  const facts = [
    findingsCount(track.memberCount),
    track.externalUrls.mixcloud ?? track.externalUrls.youtube ?? track.externalUrls.soundcloud,
  ].filter(Boolean);

  return [`- **${track.title}** (${coordinate})`, `  ${facts.join(" · ")}`].join("\n");
}

// /llms.txt: the static map (public/llms.txt), re-served with the text/markdown
// content-type it is advertised as (Cloudflare's static handler serves the raw
// file as text/plain). Same bytes, honest content-type — the llms-full.txt shape.
function llmsTxtResponse(): Response {
  return new Response(llmsTxt, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/markdown; charset=utf-8",
      Link: agentLinkHeader,
      Vary: "Accept",
      "x-markdown-tokens": String(Math.ceil(llmsTxt.length / 4)),
    },
  });
}

async function llmsFullResponse(): Promise<Response> {
  const all: FeedItem[] = [];
  let cursor: TrackCursor | undefined;
  let totalCount = 0;

  do {
    const page = await listTracks({
      cursor,
      includeMixtapes: true,
      lean: true,
      limit: llmsFullPageSize,
    });
    totalCount = page.totalCount;
    all.push(...page.tracks);
    cursor = page.nextCursor ? decodeTrackCursor(page.nextCursor) : undefined;
  } while (cursor && all.length < llmsFullMaxFindings);

  // The browse-by-feel launch gate again: until the whole map is named, strip the
  // galaxy fact from every finding here too (the per-finding "{name} galaxy" line in
  // renderFinding reads `track.galaxy`), so a named galaxy never leaks before the lens
  // ships. Post-launch the facts and the "More" pointer light up together.
  const galaxiesLive = await isGalaxyMapFullyNamed();
  const tracks = galaxiesLive
    ? all
    : all.map((track) => (track.type === "mixtape" ? track : { ...track, galaxy: undefined }));

  const markdown = renderLlmsFull(tracks, totalCount, galaxiesLive);

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

${fluncleDescription} One selector, no team. Dates mark when he found it: the day Fluncle first heard the tune, not the day it released.

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

The archive is a full MCP server (Streamable HTTP, no auth) at \`${siteUrl}/mcp\`, not just tools:

- **Tools**: \`list_tracks\`, \`get_track\` (read one finding/mixtape by Log ID coordinate or Spotify id), \`get_random_track\`, \`search_tracks\`, \`submit_track\`, \`subscribe_newsletter\`.
- **Resources**: read the archive as a corpus, each finding at \`fluncle://finding/<logId>\` and each mixtape at \`fluncle://mixtape/<logId>\`, returning its public record.
- **Prompts**: Fluncle-voiced starting points. \`recommend_finding\` (a finding for a mood), \`walk_recent_night\`, \`decode_coordinate\`.

The server card (SEP-2127) is at \`${siteUrl}/.well-known/mcp/server-card.json\`.

## Everything else

- \`GET /rss.xml\`: the 25 most recent findings as RSS.
- \`GET /llms.txt\`: the plain-language map of the Galaxy.
- \`GET /api/v1/openapi.json\`: this API as an OpenAPI 3.1 document.
- \`GET /api/v1/health\`: liveness, \`{"ok": true}\`.
- \`ssh rave.fluncle.com\`: the rave terminal, the deep end of the Galaxy. Bring a TTY.
`;
