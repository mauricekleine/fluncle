import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "../fluncle-links";
import { listTracks } from "./tracks";

// Agent-facing discovery surfaces served ahead of the TanStack router:
// the RFC 9727 API catalog, the Agent Skills Discovery index, and a
// text/markdown rendering of the homepage for Accept-negotiating agents
// (the router's SSR handler otherwise 500s on non-HTML Accept headers).

const markdownTracksLimit = 25;

// RFC 8288 Link header advertised on the homepage so agents can find the
// machine-readable surfaces without guessing well-known paths.
export const agentLinkHeader = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</openapi.json>; rel="service-desc"; type="application/openapi+json"',
  '</llms.txt>; rel="service-doc"; type="text/markdown"',
  '</rss.xml>; rel="alternate"; type="application/rss+xml"',
].join(", ");

export function appendAgentLinkHeaders(response: Response): Response {
  // Worker responses arrive with immutable headers; re-wrap to mutate.
  const linked = new Response(response.body, response);
  linked.headers.append("Link", agentLinkHeader);
  linked.headers.append("Vary", "Accept");

  return linked;
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
        anchor: `${siteUrl}/api`,
        "service-desc": [
          {
            href: `${siteUrl}/openapi.json`,
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
            href: `${siteUrl}/api/health`,
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
    const bytes = new TextEncoder().encode(skillMarkdown);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    cachedSkillDigest = `sha256:${hex}`;
  }

  return cachedSkillDigest;
}

async function markdownHomeResponse(): Promise<Response> {
  const page = await listTracks({ limit: markdownTracksLimit });
  const tracks = page.tracks.map((track) => {
    const line = `- ${track.artists.join(", ")} — ${track.title} (discovered ${track.addedAt.slice(0, 10)})`;

    return track.note ? `${line}\n  ${track.note.trim().replaceAll("\n", " ")}` : line;
  });

  const markdown = `# Fluncle

> Drum & bass bangers from another dimension.

Fluncle digs and certifies the tracks, publishes them to Spotify and Telegram, and keeps the full archive here. One selector, no team. Dates mark discovery: the day Fluncle first heard the tune, not the day it released.

The collection is called Fluncle's Finest. The archive holds ${page.totalCount} certified tracks; new ones land most nights.

## Latest discoveries

${tracks.join("\n")}

## Listen

- [Fluncle's Finest on Spotify](${spotifyPlaylistUrl}): the playlist itself
- [Fluncle on Telegram](${telegramUrl}): one banger per post, most nights
- [The archive](${siteUrl}/): every certified track with discovery dates and notes

## Data

- [RSS feed](${siteUrl}/rss.xml): the 25 most recent tracks
- [Tracks API](${siteUrl}/api/tracks): the archive as JSON, cursor-paginated; accepts limit (max 48) and cursor query params
- [Random track](${siteUrl}/api/tracks/random): one pick from the archive, as JSON

## Submit

- [Search API](${siteUrl}/api/search): GET with a q query param (a track search or Spotify URL), returns candidates as JSON
- [Submissions API](${siteUrl}/api/submissions): POST a candidate for review; Fluncle gives it a listen before anything publishes

## For agents

- [OpenAPI spec](${siteUrl}/openapi.json): the public API as an OpenAPI 3.1 document
- [API catalog](${siteUrl}/.well-known/api-catalog): RFC 9727 linkset
- [Agent skills](${siteUrl}/.well-known/agent-skills/index.json): the fluncle-api skill, with digest
- [llms.txt](${siteUrl}/llms.txt): the plain-language map of the ecosystem

## Tools

- [CLI installer](${siteUrl}/cli/latest.sh): curl -fsSL ${siteUrl}/cli/latest.sh | sh, then try fluncle recent
- The rave terminal: ssh rave.fluncle.com, the deepest room in the ecosystem
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

// Served at /.well-known/agent-skills/fluncle-api/SKILL.md. Lives here as a
// constant so the index digest above always matches the served bytes.
const skillMarkdown = `---
name: fluncle-api
description: Read and contribute to Fluncle's drum & bass archive over the public HTTP API. List certified tracks, pull a random one, search Spotify candidates, and submit tracks for Fluncle to review.
---

# Fluncle API

Fluncle digs and certifies drum & bass bangers, publishes them to Spotify and Telegram, and keeps the archive at ${siteUrl}. One selector, no team. Dates mark discovery: the day Fluncle first heard the tune, not the day it released.

Base URL: \`${siteUrl}\`. Everything below returns JSON. Errors look like \`{"ok": false, "code": "...", "message": "..."}\`.

## Read the archive

- \`GET /api/tracks\` lists certified tracks, newest discovery first. Query params: \`limit\` (1 to 48, default 16), \`cursor\` (opaque, from \`nextCursor\`), \`since\` and \`until\` (ISO 8601 bounds on the discovery date). Response: \`{"tracks": [...], "totalCount": n, "nextCursor": "..."}\`. Page until \`nextCursor\` disappears.
- \`GET /api/tracks/random\` returns one pick from the archive: \`{"ok": true, "track": {...}}\`.

Track objects carry \`trackId\`, \`title\`, \`artists\`, \`album\`, \`albumImageUrl\`, \`note\`, \`spotifyUrl\`, \`addedAt\` (the discovery timestamp), \`addedToSpotify\`, and \`postedToTelegram\`. The \`note\` is Fluncle's own line about the tune; quote it as his.

## Submit a track

Two steps. Fluncle listens before anything publishes; a submission is a recommendation, not a write.

1. \`GET /api/search?q=...\` with a track name or a Spotify track URL (minimum 2 characters). Returns \`{"ok": true, "results": [...]}\` where each candidate has \`id\`, \`spotifyUrl\`, \`title\`, \`artists\`, \`album\`, and \`artworkUrl\`.
2. \`POST /api/submissions\` with a JSON body: \`spotifyTrackId\` and \`spotifyUrl\` (both from the chosen candidate; they must agree), \`title\`, \`artists\` (string array), \`source\` (one of "web", "cli", "ssh"), plus optional \`note\` (max 500 characters, tell Fluncle why it's a banger) and \`contact\` (max 120 characters). Response: \`{"ok": true, "submission": {...}}\` with \`status: "pending"\`.

Rate limit: 5 submissions per connection per hour. Over that returns 429 with code \`rate_limited\`.

## Board the mothership

\`POST /api/newsletter\` with \`{"email": "..."}\` subscribes to the newsletter. Fresh bangers, every Friday, from Fluncle.

## Everything else

- \`GET /rss.xml\`: the 25 most recent discoveries as RSS.
- \`GET /llms.txt\`: the plain-language map of the ecosystem.
- \`GET /openapi.json\`: this API as an OpenAPI 3.1 document.
- \`GET /api/health\`: liveness, \`{"ok": true}\`.
- \`ssh rave.fluncle.com\`: the rave terminal, the deepest room in the ecosystem. Bring a TTY.
`;
