import llmsTxt from "../../../public/llms.txt?raw";
import { siteUrl, spotifyPlaylistCanonicalUrl, telegramUrl } from "../fluncle-links";
import { findingsCount } from "../format";
import { fluncleDescription } from "../identity";
import { type FeedItem } from "../mixtapes";
import { isGalaxyMapFullyNamed } from "./galaxies-map";
import { sha256Hex } from "./hash";
import { mcpToolNames } from "./mcp";
import { type TrackCursor, type TrackListItem, decodeTrackCursor, listTracks } from "./tracks";

const markdownTracksLimit = 25;

const a2aProtocolVersion = "1.0.0";

const a2aAgentVersion = "1.0.0";

const llmsFullPageSize = 100;
const llmsFullMaxFindings = 2000;

const agentLinkHeader = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"',
  '</llms.txt>; rel="service-doc"; type="text/markdown"',
  '</llms-full.txt>; rel="service-doc"; type="text/markdown"',
  '</rss.xml>; rel="alternate"; type="application/rss+xml"',
].join(", ");

export function appendAgentLinkHeaders(response: Response): Response {
  const linked = new Response(response.body, response);
  linked.headers.append("Link", agentLinkHeader);
  linked.headers.append("Vary", "Accept");

  return linked;
}

const WEB_ONION_HOSTNAME = "p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd";

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

    case "/.well-known/agent-card.json":
    case "/.well-known/agent.json":
      return agentCardResponse();
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

function agentCard() {
  return {
    capabilities: { pushNotifications: false, streaming: false },

    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    description: fluncleDescription,

    documentationUrl: `${siteUrl}/llms.txt`,
    name: "Fluncle",

    preferredTransport: "HTTP+JSON",
    protocolVersion: a2aProtocolVersion,
    provider: { organization: "Fluncle", url: siteUrl },
    skills: [
      {
        description:
          "Search Fluncle's drum & bass archive by Log ID coordinate, artist, label, album, a bare word, a plain-language question, or 'sounds like <a real track>'. Findings come first, and an empty answer means nothing in the archive matched. This searches the archive; search-tracks searches Spotify for something to submit.",
        examples: [
          "Search the archive for rollers above 170 bpm",
          "Look up the finding at 004.7.2I",
        ],
        id: "search-archive",
        name: "Search the archive",
        tags: ["drum-and-bass", "archive", "search"],
      },
      {
        description:
          "Search Spotify for track candidates by name or Spotify track URL. Use a result to submit a track for Fluncle to review. This searches Spotify, not Fluncle's archive; search-archive searches the archive.",
        examples: ["Search for a Camo & Krooked track", "Find candidates for a Spotify track URL"],
        id: "search-tracks",
        name: "Search tracks",
        tags: ["drum-and-bass", "search", "spotify"],
      },
      {
        description:
          "List the most recent findings and mixtapes in Fluncle's drum & bass archive, newest first, cursor-paginated.",
        examples: ["List the latest findings"],
        id: "list-findings",
        name: "Recent findings",
        tags: ["drum-and-bass", "archive", "catalogue"],
      },
      {
        description:
          "List every track Fluncle holds, newest release first, one numbered page at a time; certified=true narrows to findings, certified=false to the rest.",
        examples: ["Page through Fluncle's archive"],
        id: "list-tracks",
        name: "Every track",
        tags: ["drum-and-bass", "archive", "catalogue"],
      },
      {
        description:
          "Read one finding or mixtape in full by its Log ID coordinate or Spotify track id, or pull a random certified track from the archive.",
        examples: ["Read the finding at fluncle://012.8.0A", "Pull a random finding"],
        id: "get-track",
        name: "Read one finding",
        tags: ["drum-and-bass", "finding", "coordinate"],
      },
      {
        description:
          "Submit a track to Fluncle for review by Spotify track URL. Fluncle gives it a listen before anything publishes.",
        examples: ["Submit a Spotify track URL for Fluncle to review"],
        id: "submit-track",
        name: "Submit a track",
        tags: ["drum-and-bass", "submission"],
      },
      {
        description:
          "Subscribe an email address to Fluncle's newsletter. Fresh bangers, every Friday, from Fluncle.",
        examples: ["Subscribe an email address to the newsletter"],
        id: "subscribe-newsletter",
        name: "Subscribe to the newsletter",
        tags: ["newsletter", "email"],
      },
    ],

    url: `${siteUrl}/api/v1`,
    version: a2aAgentVersion,
  };
}

function agentCardResponse(): Response {
  return new Response(JSON.stringify(agentCard(), null, 2), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}

async function skillsIndexResponse(): Promise<Response> {
  const index = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        description:
          "Read and contribute to Fluncle's drum & bass archive over the public HTTP API: list certified tracks, pull a random one, search the archive, search Spotify candidates, and submit tracks for Fluncle to review.",
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

- [Fluncle's Findings on Spotify](${spotifyPlaylistCanonicalUrl}): the playlist itself
- [Fluncle on Telegram](${telegramUrl}): one banger per post, most nights
- [The front door](${siteUrl}/): where a first visit starts, with search over the whole archive, one finding written up, the newest findings, what just came out, and the four ways into the wider index
- [The archive](${siteUrl}/findings): every certified track with the date Fluncle found it

## Data

- [RSS feed](${siteUrl}/rss.xml): the 25 most recent tracks
- [Fresh releases feed](${siteUrl}/fresh.xml): the newest drum & bass releases over the last 30 days, as RSS (also ${siteUrl}/fresh.json as a JSON Feed). Release-dated (when a tune came out), not found-dated
- [Findings API](${siteUrl}/api/v1/findings): the feed as JSON, newest found first, cursor-paginated; accepts limit (max 48) and cursor query params
- [Tracks API](${siteUrl}/api/v1/tracks): every track, newest release first, numbered pages (page); certified=true narrows to findings, certified=false to the rest
- [Fresh API](${siteUrl}/api/v1/tracks/fresh): what just came out, the newest releases over a 30-day window, as JSON; accepts limit (max 100)
- [Random track](${siteUrl}/api/v1/tracks/random): one pick from the archive, as JSON
- [Archive search API](${siteUrl}/api/v1/search/archive): search the archive by coordinate, artist, label, album, a bare word, or a plain-language question, as JSON. This searches the archive itself; the Spotify candidate search under Submit is a different endpoint
- [Identity](${siteUrl}/identity): look a recording up by ISRC, MusicBrainz recording id, or Log ID and get its identifiers and platform links, one page each at ${siteUrl}/identity/{key}. Every link says how Fluncle came to trust it and when he last checked, and every gap is named: he looked and found nothing, he will not look, or he hands out no such link. Same answer as JSON at ${siteUrl}/api/v1/tracks/-?isrc={isrc} or ?mbid={mbid}. Metered at 30 requests a minute and 1,000 a day per caller; free, no key
- [Artists API](${siteUrl}/api/v1/artists): every artist Fluncle holds, A to Z, paginated, as JSON; /api/v1/artists/{slug} for one artist. Each resolves to a page at ${siteUrl}/artist/{slug}: that artist's findings plus their verified identity links (MusicGroup + sameAs)
- [Labels API](${siteUrl}/api/v1/labels): every label Fluncle holds, A to Z, paginated, as JSON; /api/v1/labels/{slug} for one label's identity, imprint lineage, and counts. Each resolves to a page at ${siteUrl}/label/{slug}
- [Albums API](${siteUrl}/api/v1/albums): every record Fluncle holds, A to Z, paginated, as JSON; /api/v1/albums/{slug} for one record's identity, cover, and counts. Each resolves to a page at ${siteUrl}/album/{slug}
- [Mixtapes API](${siteUrl}/api/v1/mixtapes): Fluncle's own DJ mixtapes as JSON, each a checkpoint set with an F-marked Log ID and its tracklist; browse them at ${siteUrl}/mixtapes${galaxiesLine}
- [The artists](${siteUrl}/artists): every artist in the archive, A to Z, the ones Fluncle has certified a finding from marked in gold. Each resolves to a page at ${siteUrl}/artist/{slug}: that artist's findings and their verified identity links
- [The labels](${siteUrl}/labels): every label in the archive, A to Z, the ones Fluncle has certified a finding on marked in gold. Each resolves to a page at ${siteUrl}/label/{slug}: that label's findings, the artists on it, and the rest of its catalogue
- [The albums](${siteUrl}/albums): every record in the archive, A to Z, the ones Fluncle has certified a finding from marked in gold. Each resolves to a page at ${siteUrl}/album/{slug}: that record's findings, its artists, and the label it came out on
- [The tracks](${siteUrl}/tracks): every recording Fluncle holds, newest release first, filterable by release year, tempo, key, and label. Each one the archive can name resolves to a page at ${siteUrl}/track/{trackId}: that recording's artists, the record it is from, the label, the release date, tempo and key, the services the archive holds a link to, and what sits closest to it in sound. A recording Fluncle has certified is a finding, so its track URL redirects to its /log coordinate page
- [What just came out](${siteUrl}/fresh): the newest drum & bass across the whole archive, freshest first. Every release from the last 30 days, ordered by when it came out (not by when Fluncle found it)

## Submit

- [Search API](${siteUrl}/api/v1/search): GET with a q query param (a track search or Spotify URL), returns candidates as JSON
- [Submissions API](${siteUrl}/api/v1/submissions): POST a candidate for review; Fluncle gives it a listen before anything publishes

## For agents

- [OpenAPI spec](${siteUrl}/api/v1/openapi.json): the public API as an OpenAPI 3.1 document
- [MCP server](${siteUrl}/mcp): the archive over Model Context Protocol (Streamable HTTP, no auth), tools, resources (each finding at fluncle://finding/<logId>), and Fluncle-voiced prompts
- [MCP server card](${siteUrl}/.well-known/mcp/server-card.json): SEP-2127 discovery card for the MCP endpoint
- [Agent card](${siteUrl}/.well-known/agent-card.json): A2A agent card listing Fluncle's actionable skills (search, list, read, submit, subscribe)
- [API catalog](${siteUrl}/.well-known/api-catalog): RFC 9727 linkset
- [Agent skills](${siteUrl}/.well-known/agent-skills/index.json): the fluncle-api skill, with digest
- [llms.txt](${siteUrl}/llms.txt): the plain-language map of the Galaxy
- [llms-full.txt](${siteUrl}/llms-full.txt): the entire archive in one document, every finding

## Tools

- [CLI installer](${siteUrl}/cli/latest.sh): curl -fsSL ${siteUrl}/cli/latest.sh | sh, then try fluncle recent
- [Fluncle Lens](https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk): a Chrome extension that finds fluncle:// coordinates on any web page and links each to its /log finding
- [Fluncle for iOS](https://apps.apple.com/app/id6790080540): the native app carrying the feed, the archive, the radio, and each finding's /log screen, with push when a new banger lands
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

Every finding has a permanent coordinate, a Log ID, written sector.orbit.mark, for example 004.7.2I, full form fluncle://004.7.2I. The sector counts the days from the epoch (2026-05-30) to the day Fluncle found the tune; the tail is a stable signature derived from the recording itself. Each one is stamped once, never reassigned, and resolves to a log page at ${siteUrl}/log/<id>.

## The findings (${totalCount})

${findings}
${omitted > 0 ? `\n_${omitted} older findings omitted here; page the rest at ${siteUrl}/api/v1/findings._\n` : ""}
## More

- The map: ${siteUrl}/llms.txt
- The playlist: ${spotifyPlaylistCanonicalUrl}
- The Telegram feed: ${telegramUrl}
- The JSON API: ${siteUrl}/api/v1/findings
- The archive search: ${siteUrl}/api/v1/search/archive
- The artists: ${siteUrl}/artists
- The labels: ${siteUrl}/labels
- The albums: ${siteUrl}/albums
- What just came out: ${siteUrl}/fresh
- The mixtapes: ${siteUrl}/api/v1/mixtapes${galaxiesLive ? `\n- The sonic galaxies: ${siteUrl}/api/v1/galaxies` : ""}
- The MCP server: ${siteUrl}/mcp
`;
}

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

const skillMarkdown = `---
name: fluncle-api
description: Read and contribute to Fluncle's drum & bass archive over the public HTTP API. List certified tracks, pull a random one, search the archive, search Spotify candidates, and submit tracks for Fluncle to review.
---

# Fluncle API

${fluncleDescription} One selector, no team. Dates mark when he found it: the day Fluncle first heard the tune, not the day it released.

Base URL: \`${siteUrl}\`. Everything below returns JSON. Errors look like \`{"ok": false, "code": "...", "message": "..."}\`.

## Read the archive

- \`GET /api/v1/findings\` lists certified tracks, newest found first. Query params: \`limit\` (1 to 48, default 16), \`cursor\` (opaque, from \`nextCursor\`), \`since\` and \`until\` (ISO 8601 bounds on the date found). Response: \`{"tracks": [...], "totalCount": n, "nextCursor": "..."}\`. Page until \`nextCursor\` disappears.
- \`GET /api/v1/tracks\` lists every track Fluncle holds, newest release first. Query params: \`page\` (1-based), \`certified\` (\`true\` for findings only, \`false\` for the rest).
- \`GET /api/v1/tracks/{idOrLogId}\` reads one finding or mixtape in full, by its Log ID coordinate (\`004.7.2I\`) or its Spotify track id.
- \`GET /api/v1/tracks/random\` returns one pick from the archive: \`{"ok": true, "track": {...}}\`.
- \`GET /api/v1/search/archive\` searches the archive itself by coordinate, artist, label, album, a bare word, or a plain-language question. Query param: \`q\`. An empty result means nothing in the archive matched. This is the archive search; the Spotify candidate search under "Submit a track" is a different endpoint.

Every recording the archive can name has a page at \`${siteUrl}/track/{trackId}\`, keyed on \`trackId\`; a certified one redirects to its coordinate page at \`${siteUrl}/log/{logId}\`.

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

- **Tools** (derived from the live tool set; call \`tools/list\` for each tool's full schema): ${mcpToolNames.map((name) => `\`${name}\``).join(", ")}. Includes the archive reads (\`list_findings\` the found-order feed, \`list_tracks\` the whole-archive release-ordered browse, \`get_track\` by Log ID coordinate or Spotify id, \`search_archive\`), the artist/label/album browse (\`list_artists\`, \`list_albums\`, \`list_labels\` walk the whole archive A to Z; \`list_artist_catalogue\`, \`list_label_catalogue\`, \`list_album_catalogue\` list one entity's tracks), and the writes (\`submit_track\`, \`subscribe_newsletter\`).
- **Resources**: read the archive as a corpus, each finding at \`fluncle://finding/<logId>\` and each mixtape at \`fluncle://mixtape/<logId>\`, returning its public record.
- **Prompts**: Fluncle-voiced starting points. \`recommend_finding\` (a finding for a mood), \`walk_recent_night\`, \`decode_coordinate\`.

The server card (SEP-2127) is at \`${siteUrl}/.well-known/mcp/server-card.json\`.

## Everything else

- \`GET /rss.xml\`: the 25 most recent findings as RSS.
- \`GET /fresh.xml\` (+ \`/fresh.json\`): the newest releases over a 30-day window, as RSS / JSON Feed.
- \`GET /api/v1/tracks/fresh\`: what just came out, as JSON (limit max 100).
- \`GET /llms.txt\`: the plain-language map of the Galaxy.
- \`GET /api/v1/openapi.json\`: this API as an OpenAPI 3.1 document.
- \`GET /api/v1/health\`: liveness, \`{"ok": true}\`.
- \`ssh rave.fluncle.com\`: the rave terminal, the deep end of the Galaxy. Bring a TTY.
`;
