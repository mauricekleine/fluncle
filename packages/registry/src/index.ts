// The Fluncle surfaces registry — the single, in-code source of truth for every
// place Fluncle is reachable across the Galaxy: web routes, subdomains, the public
// API, the feeds, the agent-discovery surfaces, the delegated DNS zone, the SSH
// terminal, the MCP server, the CLI, and the on-box Hermes crons.
//
// It is PURE DATA (no runtime side effects, no I/O): just a typed catalog plus a
// few selectors over it. Nothing consumes it yet — it exists so the surfaces that
// will (a `/status` prober, the homepage dev-row, llms.txt, the sitemap, and a
// surfaces-doctrine doc) all read the same list instead of each hand-maintaining a
// drifting copy. When a new surface ships, add it here once; every consumer picks
// it up.
//
// Scope discipline: this catalogs PUBLIC-facing and operator-known surfaces — the
// reach of Fluncle's tentacles across the web. It is NOT a route table (the web app
// owns its own routing) and NOT a secrets/infra inventory. Internal IPs, hostnames,
// op-paths, and credentials never belong here.

// ── Kinds ──────────────────────────────────────────────────────────────────────

/**
 * What FAMILY a surface belongs to. Drives how a consumer renders/probes it:
 * - `web_route`  a page on www.fluncle.com (the archive, /log, /about, …)
 * - `subdomain`  a sibling host on the same Worker (galaxy., radio., found., dig.)
 * - `api`        a JSON HTTP endpoint (the public /api/v1 surface)
 * - `feed`       a subscribable syndication document (RSS/Atom/JSON Feed/podcast/ICS)
 * - `discovery`  a machine-/crawler-facing map (sitemap, robots, llms.txt, well-known)
 * - `dns`        the delegated authoritative DNS zone (dig.fluncle.com)
 * - `ssh`        the rave terminal (ssh rave.fluncle.com)
 * - `mcp`        the Model Context Protocol server (/mcp)
 * - `cli`        a `fluncle` CLI command (the thin HTTP client)
 * - `cron`       an on-box Hermes scheduled job (enrichment + the newsletter)
 */
export type SurfaceKind =
  | "web_route"
  | "subdomain"
  | "api"
  | "feed"
  | "discovery"
  | "dns"
  | "ssh"
  | "mcp"
  | "cli"
  | "cron";

/**
 * How loudly a surface is presented. `primary` surfaces lead the homepage dev-row
 * and the doctrine doc; `hidden` ones are real and registered but deliberately not
 * advertised (operator/agent-only or a low-level discovery detail).
 */
export type SurfaceWeight = "primary" | "secondary" | "tertiary" | "hidden";

/**
 * How a `/status` prober should check a surface, when it is probeable. `cron`
 * surfaces are checked by freshness of their last on-box run, not an HTTP hit, so
 * they carry the cron name + cadence instead of a URL probe target.
 */
export type ProbeConfig = {
  /** `http` GETs the surface's URL; `cron` checks the named job's last-run freshness. */
  kind: "http" | "cron";
  /** The Hermes job name (kind `cron` only), e.g. "fluncle-enrich". */
  cronName?: string;
  /** Expected interval between runs/checks, in ms (a probe cadence or a cron interval). */
  cadenceMs?: number;
  /** How long the prober waits before calling a check failed, in ms. */
  timeoutMs?: number;
};

/** One Fluncle surface. URL/route/command/subdomain are populated per `kind`. */
export type Surface = {
  /** A stable, human-readable id, unique across the catalog (e.g. "web.log", "api.tracks"). */
  name: string;
  kind: SurfaceKind;
  weight: SurfaceWeight;
  /** The canonical absolute URL, when the surface lives at a fixed address. */
  url?: string;
  /** The host for a `subdomain`/`dns`/`ssh` surface (e.g. "galaxy.fluncle.com"). */
  subdomain?: string;
  /** The www.fluncle.com path for a `web_route`/`feed`/`discovery`/`api` surface. */
  route?: string;
  /** The shell invocation for a `cli`/`ssh` surface (e.g. "fluncle recent"). */
  command?: string;
  /** What this surface exposes, in plain words — the payload, the page, the tools. */
  exposedContent: string[];
  /** The wire format an `api`/`feed`/`discovery` surface emits (e.g. "application/json"). */
  apiFormat?: string;
  /** How `/status` should probe this surface, when it is probeable. */
  probeConfig?: ProbeConfig;
  /** A discovery/advertisement URL that points AT this surface (a card, a linkset entry). */
  discoveryUrl?: string;
  /** Operator-only context: tier, caveats, where the source lives. Never secrets. */
  operatorNotes?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Home base. Every www route + feed + discovery doc hangs off this origin. */
const SITE = "https://www.fluncle.com";

// Probe cadences, named so they read at the call site. The HTTP surfaces are
// probed by the `fluncle-healthcheck` cron every ~10m; the crons themselves are
// checked by their own interval (see each cron surface's probeConfig).
const PROBE_CADENCE_MS = 10 * 60 * 1000; // 10m — the healthcheck cron's tick.
const PROBE_TIMEOUT_MS = 10 * 1000; // 10s — a generous ceiling for a cold Worker.

const MINUTE_MS = 60 * 1000;

// ── The catalog ────────────────────────────────────────────────────────────────

/**
 * Every Fluncle surface, inventoried from the codebase (apps/web routes + router
 * rewrites, apps/dns, apps/ssh, apps/cli, the /api/v1 tree, the agent-discovery +
 * MCP libs, and the docs/agents/hermes/cron jobs). Append a surface here when it
 * ships; keep `name` unique.
 */
export const SURFACES: readonly Surface[] = [
  // ── Web routes (www.fluncle.com) ──────────────────────────────────────────
  {
    exposedContent: ["the archive — every certified finding, newest first, cover-led"],
    kind: "web_route",
    name: "web.home",
    operatorNotes: "The Worker root. galaxy./radio. rewrite their root to /galaxy and /radio.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/",
    url: `${SITE}/`,
    weight: "primary",
  },
  {
    exposedContent: [
      "the log index — every finding's coordinate page",
      "/log/:logId — one finding's permanent home (the Log ID resolves here)",
    ],
    kind: "web_route",
    name: "web.log",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/log",
    url: `${SITE}/log`,
    weight: "primary",
  },
  {
    exposedContent: ["Fluncle's own DJ mixtapes — each a checkpoint set with an F-marked Log ID"],
    kind: "web_route",
    name: "web.mixtapes",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/mixtapes",
    url: `${SITE}/mixtapes`,
    weight: "primary",
  },
  {
    exposedContent: [
      "the feed-first Stories surface — full-bleed findings",
      "/stories/:logId — one finding as a Story",
    ],
    kind: "web_route",
    name: "web.stories",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/stories",
    url: `${SITE}/stories`,
    weight: "secondary",
  },
  {
    exposedContent: ["who Fluncle is, what the Galaxy is, how to read a Log ID"],
    kind: "web_route",
    name: "web.about",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/about",
    url: `${SITE}/about`,
    weight: "secondary",
  },
  {
    exposedContent: [
      "the newsletter archive — every sent edition",
      "/newsletter/:number — one past edition rendered on the web",
    ],
    kind: "web_route",
    name: "web.newsletter",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/newsletter",
    url: `${SITE}/newsletter`,
    weight: "secondary",
  },
  {
    exposedContent: [
      "the Fumadocs developer docs",
      "/docs/api — the embedded Scalar API reference",
    ],
    kind: "web_route",
    name: "web.docs",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/docs",
    url: `${SITE}/docs`,
    weight: "secondary",
  },
  {
    exposedContent: ["the public service-health dashboard — uptime per service, recent events"],
    kind: "web_route",
    name: "web.status",
    operatorNotes:
      "The future status.fluncle.com host points here. The fluncle-healthcheck cron POSTs its snapshots to the agent-tier record_health op that this page reads.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/status",
    url: `${SITE}/status`,
    weight: "secondary",
  },
  {
    exposedContent: ["the Galaxy game — the 8-bit fly-to-every-banger arcade front door"],
    kind: "web_route",
    name: "web.galaxy",
    operatorNotes: "Reachable at galaxy.fluncle.com, whose root the router rewrites to /galaxy.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/galaxy",
    url: `${SITE}/galaxy`,
    weight: "primary",
  },
  {
    exposedContent: [
      "the cycling observation station — Fluncle's spoken field observations on a loop",
    ],
    kind: "web_route",
    name: "web.radio",
    operatorNotes: "Reachable at radio.fluncle.com, whose root the router rewrites to /radio.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/radio",
    url: `${SITE}/radio`,
    weight: "secondary",
  },
  {
    exposedContent: ["the privacy policy"],
    kind: "web_route",
    name: "web.privacy",
    route: "/privacy",
    url: `${SITE}/privacy`,
    weight: "tertiary",
  },

  // ── Subdomains (sibling hosts on the same Worker) ──────────────────────────
  {
    exposedContent: ["the Galaxy game's front door (root rewrites to /galaxy)"],
    kind: "subdomain",
    name: "subdomain.galaxy",
    operatorNotes:
      "Isomorphic host-rewrite in apps/web router (input/output) so SSR + hydration agree.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "galaxy.fluncle.com",
    url: "https://galaxy.fluncle.com",
    weight: "primary",
  },
  {
    exposedContent: ["the observation station (root rewrites to /radio)"],
    kind: "subdomain",
    name: "subdomain.radio",
    operatorNotes: "Isomorphic host-rewrite in apps/web router so SSR + hydration agree.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "radio.fluncle.com",
    url: "https://radio.fluncle.com",
    weight: "secondary",
  },
  {
    exposedContent: [
      "the R2 media zone — each finding's video bundle + mixtape audio",
      "the /cdn-cgi/media transform base (same zone, no cross-origin)",
    ],
    kind: "subdomain",
    name: "subdomain.found",
    operatorNotes: "FOUND_BASE in apps/web/src/lib/media.ts. Probed on /status as service `r2`.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "found.fluncle.com",
    url: "https://found.fluncle.com",
    weight: "tertiary",
  },
  {
    exposedContent: ["the delegated DNS zone's host label (see the dns surface for the resolver)"],
    kind: "subdomain",
    name: "subdomain.dig",
    operatorNotes: "The zone is served by apps/dns; see the `dns.zone` surface.",
    subdomain: "dig.fluncle.com",
    url: "https://dig.fluncle.com",
    weight: "tertiary",
  },
  {
    exposedContent: ["the planned status host — points at /status"],
    kind: "subdomain",
    name: "subdomain.status",
    operatorNotes: "PLANNED. Not yet wired; the page already lives at www.fluncle.com/status.",
    subdomain: "status.fluncle.com",
    url: "https://status.fluncle.com",
    weight: "tertiary",
  },
  {
    exposedContent: [
      "the Tor onion mirror of www.fluncle.com — the archive, API, RSS, and MCP over Tor",
    ],
    kind: "subdomain",
    name: "subdomain.onion",
    operatorNotes:
      "An onionspray mirror. Advertised via Tor Browser's Onion-Location pill. Probed on /status as service `onion`. Runbook: docs/tor.md.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion",
    url: "http://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion",
    weight: "tertiary",
  },

  // ── Public API (the /api/v1 surface) ───────────────────────────────────────
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["the archive as JSON, cursor-paginated (limit max 48, cursor)"],
    kind: "api",
    name: "api.tracks",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/tracks",
    url: `${SITE}/api/v1/tracks`,
    weight: "primary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["one finding or mixtape by Spotify id or Log ID"],
    kind: "api",
    name: "api.track",
    route: "/api/v1/tracks/:idOrLogId",
    url: `${SITE}/api/v1/tracks/:idOrLogId`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["one finding at random"],
    kind: "api",
    name: "api.tracks.random",
    route: "/api/v1/tracks/random",
    url: `${SITE}/api/v1/tracks/random`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["published mixtapes as JSON"],
    kind: "api",
    name: "api.mixtapes",
    route: "/api/v1/mixtapes",
    url: `${SITE}/api/v1/mixtapes`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["Spotify search candidates for submitting a track"],
    kind: "api",
    name: "api.search",
    route: "/api/v1/search",
    url: `${SITE}/api/v1/search`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["submit a track for review (POST)"],
    kind: "api",
    name: "api.submissions",
    route: "/api/v1/submissions",
    url: `${SITE}/api/v1/submissions`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["subscribe to the newsletter (POST); the editions archive"],
    kind: "api",
    name: "api.newsletter",
    route: "/api/v1/newsletter",
    url: `${SITE}/api/v1/newsletter`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["the Stories payload as JSON"],
    kind: "api",
    name: "api.stories",
    route: "/api/v1/stories",
    url: `${SITE}/api/v1/stories`,
    weight: "tertiary",
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["the radio shared-clock now-playing slot"],
    kind: "api",
    name: "api.radio.now-playing",
    route: "/api/v1/radio/now-playing",
    url: `${SITE}/api/v1/radio/now-playing`,
    weight: "tertiary",
  },
  {
    apiFormat: "application/json",
    exposedContent: ["the liveness probe — the canonical web health check"],
    kind: "api",
    name: "api.health",
    operatorNotes:
      "Linked as the `status` relation from /.well-known/api-catalog. Service `web` on /status.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/health",
    url: `${SITE}/api/health`,
    weight: "tertiary",
  },

  // ── Feeds (subscribable syndication documents) ─────────────────────────────
  {
    apiFormat: "application/rss+xml",
    exposedContent: ["the 25 most recent findings and mixtapes"],
    kind: "feed",
    name: "feed.rss",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/rss.xml",
    url: `${SITE}/rss.xml`,
    weight: "primary",
  },
  {
    apiFormat: "application/atom+xml",
    exposedContent: ["the recent findings and mixtapes as an Atom feed"],
    kind: "feed",
    name: "feed.atom",
    route: "/atom.xml",
    url: `${SITE}/atom.xml`,
    weight: "secondary",
  },
  {
    apiFormat: "application/feed+json",
    exposedContent: ["the recent findings and mixtapes as a JSON Feed"],
    kind: "feed",
    name: "feed.json",
    route: "/feed.json",
    url: `${SITE}/feed.json`,
    weight: "secondary",
  },
  {
    apiFormat: "application/rss+xml",
    exposedContent: ["the mixtapes as a podcast feed (episode audio on found.fluncle.com)"],
    kind: "feed",
    name: "feed.podcast",
    route: "/podcast.xml",
    url: `${SITE}/podcast.xml`,
    weight: "secondary",
  },
  {
    apiFormat: "text/calendar",
    exposedContent: ["planned events as an iCalendar feed (Twitch-linked VEVENTs)"],
    kind: "feed",
    name: "feed.calendar",
    route: "/calendar.ics",
    url: `${SITE}/calendar.ics`,
    weight: "tertiary",
  },

  // ── Discovery (machine-/crawler-facing maps) ──────────────────────────────
  {
    apiFormat: "application/xml",
    exposedContent: ["the XML sitemap of every public page"],
    kind: "discovery",
    name: "discovery.sitemap",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/sitemap.xml",
    url: `${SITE}/sitemap.xml`,
    weight: "secondary",
  },
  {
    apiFormat: "text/plain",
    exposedContent: [
      "the crawl policy + Content-Signal (search/AI-input/AI-train all yes) + sitemap link",
    ],
    kind: "discovery",
    name: "discovery.robots",
    operatorNotes:
      "Cloudflare's managed robots.txt can prepend directives; this file is the origin's intent.",
    route: "/robots.txt",
    url: `${SITE}/robots.txt`,
    weight: "tertiary",
  },
  {
    apiFormat: "text/markdown",
    discoveryUrl: `${SITE}/.well-known/api-catalog`,
    exposedContent: ["the plain-language map of the Galaxy for LLMs"],
    kind: "discovery",
    name: "discovery.llms",
    route: "/llms.txt",
    url: `${SITE}/llms.txt`,
    weight: "primary",
  },
  {
    apiFormat: "text/markdown",
    exposedContent: ["the entire archive in one ingestible markdown document, every finding"],
    kind: "discovery",
    name: "discovery.llms-full",
    route: "/llms-full.txt",
    url: `${SITE}/llms-full.txt`,
    weight: "secondary",
  },
  {
    apiFormat: "application/openapi+json",
    exposedContent: ["the public API as an OpenAPI 3.1 document (admin paths excluded)"],
    kind: "discovery",
    name: "discovery.openapi",
    route: "/api/v1/openapi.json",
    url: `${SITE}/api/v1/openapi.json`,
    weight: "secondary",
  },
  {
    apiFormat: "application/json",
    exposedContent: ["the SEP-2127 discovery card for the MCP endpoint"],
    kind: "discovery",
    name: "discovery.mcp-server-card",
    route: "/.well-known/mcp/server-card.json",
    url: `${SITE}/.well-known/mcp/server-card.json`,
    weight: "tertiary",
  },
  {
    apiFormat: "application/linkset+json",
    exposedContent: ["the RFC 9727 linkset pointing at the machine-readable surfaces"],
    kind: "discovery",
    name: "discovery.api-catalog",
    route: "/.well-known/api-catalog",
    url: `${SITE}/.well-known/api-catalog`,
    weight: "tertiary",
  },
  {
    apiFormat: "application/json",
    exposedContent: ["the fluncle-api agent skill index (with the SKILL.md digest)"],
    kind: "discovery",
    name: "discovery.agent-skills",
    route: "/.well-known/agent-skills/index.json",
    url: `${SITE}/.well-known/agent-skills/index.json`,
    weight: "tertiary",
  },

  // ── MCP server ────────────────────────────────────────────────────────────
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/.well-known/mcp/server-card.json`,
    exposedContent: [
      "the archive as MCP tools (Streamable HTTP, no auth): list_tracks, get_random_track, get_status, search_tracks, submit_track, subscribe_newsletter",
    ],
    kind: "mcp",
    name: "mcp.server",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/mcp",
    url: `${SITE}/mcp`,
    weight: "primary",
  },

  // ── DNS (the delegated authoritative zone) ─────────────────────────────────
  {
    command: "dig TXT 004.7.2I.dig.fluncle.com",
    exposedContent: [
      "a finding's coordinate as a TXT record (e.g. 004.7.2I.dig.fluncle.com)",
      "the special labels `random` and `latest`",
    ],
    kind: "dns",
    name: "dns.zone",
    operatorNotes:
      "apps/dns — a tiny authoritative server for dig.fluncle.com, reads the public API and renders a finding as TXT. Not recursive (out-of-zone is REFUSED). Probed on /status as service `dns`.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "dig.fluncle.com",
    weight: "tertiary",
  },

  // ── SSH (the rave terminal) ────────────────────────────────────────────────
  {
    command: "ssh rave.fluncle.com",
    exposedContent: [
      "the rave terminal TUI: Enter the Galaxy, Latest bangers, Mixtape archive, Submit, Subscribe, Install CLI, About",
      "deep-register one-shots: `ssh rave.fluncle.com latest|random`",
    ],
    kind: "ssh",
    name: "ssh.rave",
    operatorNotes: "apps/ssh (Go Wish/Bubble Tea). Probed on /status as service `ssh`.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "rave.fluncle.com",
    weight: "primary",
  },

  // ── CLI (the `fluncle` thin client) ────────────────────────────────────────
  {
    command: "fluncle recent",
    exposedContent: ["the latest bangers, newest first (alias `list`)"],
    kind: "cli",
    name: "cli.recent",
    weight: "primary",
  },
  {
    command: "fluncle mixtapes",
    exposedContent: ["Fluncle's checkpoint sets"],
    kind: "cli",
    name: "cli.mixtapes",
    weight: "secondary",
  },
  {
    command: "fluncle open",
    exposedContent: ["pick a track, open it in Spotify"],
    kind: "cli",
    name: "cli.open",
    weight: "secondary",
  },
  {
    command: "fluncle random",
    exposedContent: ["the archive throws one back"],
    kind: "cli",
    name: "cli.random",
    weight: "secondary",
  },
  {
    command: "fluncle subscribe",
    exposedContent: ["subscribe to the Friday newsletter"],
    kind: "cli",
    name: "cli.subscribe",
    weight: "secondary",
  },
  {
    command: "fluncle submit",
    exposedContent: ["send a track for review"],
    kind: "cli",
    name: "cli.submit",
    weight: "secondary",
  },
  {
    command: "fluncle tracks get",
    exposedContent: ["look up one finding by id or Log ID (group alias `track`)"],
    kind: "cli",
    name: "cli.tracks-get",
    weight: "tertiary",
  },
  {
    command: "fluncle about",
    exposedContent: ["Fluncle, and where to find him"],
    kind: "cli",
    name: "cli.about",
    weight: "tertiary",
  },
  {
    command: "fluncle version",
    exposedContent: ["print or check the version (--check hits the latest GitHub release)"],
    kind: "cli",
    name: "cli.version",
    weight: "tertiary",
  },
  {
    command: "fluncle admin",
    exposedContent: [
      "the operator/agent command group (hidden): tracks publish|update|enrich|video|draft|social|preview|observe|context|note, mixtapes create|update|members|publish|delete, newsletter draft|update|send|list, backfills, auth",
    ],
    kind: "cli",
    name: "cli.admin",
    operatorNotes: "Authenticated admin/agent tier. The enrichment crons drive a subset of these.",
    weight: "hidden",
  },

  // ── Crons (the on-box Hermes scheduled jobs) ───────────────────────────────
  {
    command: "fluncle admin tracks enrich --queue",
    exposedContent: [
      "BPM / key / spectral analysis on the box, write-back (--no-agent, on-box DSP)",
    ],
    kind: "cron",
    name: "cron.enrich",
    operatorNotes:
      "every 5m. Pure compute, zero LLM tokens. Source: docs/agents/hermes/scripts/enrich-sweep.*",
    probeConfig: { cadenceMs: 5 * MINUTE_MS, cronName: "fluncle-enrich", kind: "cron" },
    weight: "hidden",
  },
  {
    command: "fluncle admin tracks context --queue",
    exposedContent: [
      "Firecrawl facts → distilled context_note + a Texture: line (Worker-side Haiku)",
    ],
    kind: "cron",
    name: "cron.context-note",
    operatorNotes:
      "every 5m. --no-agent trigger; the Worker does the Firecrawl + Haiku distill. Zero on-box tokens.",
    probeConfig: { cadenceMs: 5 * MINUTE_MS, cronName: "fluncle-context-note", kind: "cron" },
    weight: "hidden",
  },
  {
    command: "fluncle admin tracks note --queue",
    exposedContent: [
      "auto-author the editorial /log note, fill-empty-only (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.note",
    operatorNotes:
      "every 10m. Hybrid --no-agent; one claude -p authors the line. Never clobbers an operator note.",
    probeConfig: { cadenceMs: 10 * MINUTE_MS, cronName: "fluncle-note", kind: "cron" },
    weight: "hidden",
  },
  {
    command: "fluncle admin tracks observe --queue",
    exposedContent: [
      "author the recovered-audio script → Worker Cartesia render (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.observation",
    operatorNotes:
      "every 60m. Hybrid --no-agent; one claude -p authors the script, the Worker voice-gates + renders.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-observation", kind: "cron" },
    weight: "hidden",
  },
  {
    command: "fluncle admin backfills discogs && fluncle admin backfills lastfm",
    exposedContent: ["Discogs id + Last.fm love catalogue repair (--no-agent, Worker HTTP)"],
    kind: "cron",
    name: "cron.backfill",
    operatorNotes: "every 30m. Pure HTTP driving, zero LLM tokens. Agent tier.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-backfill", kind: "cron" },
    weight: "hidden",
  },
  {
    command: "fluncle admin tracks queue",
    exposedContent: [
      "wake the rave-03 render box → render + ship one finding's video → park (conductor)",
    ],
    kind: "cron",
    name: "cron.render",
    operatorNotes:
      "every 60m. A conductor: triggers a detached @fluncle-video render on a scale-to-zero box.ascii box (rave-03). Never posts to social (operator-tier 403). Probed on /status as service `render-box`.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-render", kind: "cron" },
    weight: "hidden",
  },
  {
    exposedContent: [
      "probe each service → Discord-ping on a status flip → POST the /status snapshot (--no-agent)",
    ],
    kind: "cron",
    name: "cron.healthcheck",
    operatorNotes:
      "every 10m. Pure probing, zero LLM tokens. POSTs to the agent-tier record_health op that /status reads.",
    probeConfig: { cadenceMs: 10 * MINUTE_MS, cronName: "fluncle-healthcheck", kind: "cron" },
    weight: "hidden",
  },
  {
    command: "fluncle admin newsletter draft",
    exposedContent: [
      "draft + persist the weekly edition, then offer the operator a Discord Send button (the only agent cron)",
    ],
    kind: "cron",
    name: "cron.newsletter",
    operatorNotes:
      "Fri 15:00 Amsterdam (cron `0 15 * * 5`, box pinned Europe/Amsterdam for DST). The only full-agent cron. Send is operator-gated (agent token 403s send_edition). Source: docs/agents/hermes/cron/jobs.json.",
    probeConfig: {
      cadenceMs: 7 * 24 * 60 * MINUTE_MS,
      cronName: "fluncle-newsletter",
      kind: "cron",
    },
    weight: "secondary",
  },
];

// ── Selectors ────────────────────────────────────────────────────────────────

/** Every surface at the given presentation weight, in catalog order. */
export function surfacesByWeight(weight: SurfaceWeight): Surface[] {
  return SURFACES.filter((surface) => surface.weight === weight);
}

/** Every surface at the given kind, in catalog order. */
export function surfacesByKind(kind: SurfaceKind): Surface[] {
  return SURFACES.filter((surface) => surface.kind === kind);
}

/**
 * Every surface that carries a `probeConfig` — the set a `/status` prober walks.
 * Narrows the type so a consumer can read `surface.probeConfig` without a guard.
 */
export function statusProbes(): Array<Surface & { probeConfig: ProbeConfig }> {
  return SURFACES.filter(
    (surface): surface is Surface & { probeConfig: ProbeConfig } =>
      surface.probeConfig !== undefined,
  );
}

/** Every on-box Hermes cron surface, in catalog order. */
export function cronSurfaces(): Surface[] {
  return surfacesByKind("cron");
}
