# Surfaces Doctrine

The canonical map of every place Fluncle is reachable across the Galaxy — web routes, subdomains, the public API, the feeds, the agent-discovery maps, the delegated DNS zone, the SSH terminal, the MCP server, the CLI, and the on-box Hermes crons — and the checklist for wiring a new one in.

This doc replaces the old `docs/public-surfaces-checklist.md` (a hand-maintained tickbox list that drifted from the code). The decisions it recorded (per-coordinate web subdomains dropped, the `dig` surface that superseded them, the Tor mirror, the data-graph anchors) live on either in the registry itself or in `docs/ROADMAP.md`'s long-tail section.

## 1. The registry is the source of truth

Every surface is **one entry in `@fluncle/registry`** (`packages/registry/src/index.ts`) — a pure, typed catalog (`SURFACES`) plus a few selectors over it (`surfacesByWeight`, `surfacesByKind`, `statusProbes`, `cronSurfaces`). It is data, not a route table and not a secrets inventory: internal IPs, op-paths, and credentials never go in it.

The point is that one entry **fans out**. Add a surface to the registry once and every consumer — the `/status` prober, the homepage dev-row, `llms.txt`, the sitemap, and this doc — picks it up from the same list instead of each hand-maintaining a drifting copy. This doc is organized around the registry's own shape: its `SurfaceKind` families (§2) and its `SurfaceWeight` ladder (§3).

Each entry carries: a stable `name` (unique, e.g. `web.log`, `api.tracks`), a `kind`, a `weight`, the address it lives at (`url` / `route` / `subdomain` / `command`, populated per kind), `exposedContent` (what it serves, in plain words), and — where applicable — `apiFormat`, a `probeConfig` (how `/status` checks it), a `discoveryUrl` (what advertises it), and `operatorNotes` (tier, caveats, where the source lives; never secrets).

## 2. The surface inventory, by kind

Generated from the `SURFACES` catalog. Each row is the registry `name`, its address, and what it exposes; the weight column is §3's ladder. Keep this table in step with the catalog when you add or change an entry.

### Web routes — pages on `www.fluncle.com`

| Surface          | Route         | Exposes                                                                                                       | Weight    |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| `web.home`       | `/`           | the archive — every certified finding, newest first, cover-led                                                | primary   |
| `web.log`        | `/log`        | the log index + `/log/:logId`, one finding's permanent home (the Log ID resolves here)                        | primary   |
| `web.mixtapes`   | `/mixtapes`   | Fluncle's own DJ mixtapes — each a checkpoint set with an F-marked Log ID                                     | primary   |
| `web.galaxy`     | `/galaxy`     | the Galaxy game — the 8-bit fly-to-every-banger arcade front door (also at `galaxy.fluncle.com`)              | primary   |
| `web.stories`    | `/stories`    | the feed-first Stories surface + `/stories/:logId`, one finding as a Story                                    | secondary |
| `web.about`      | `/about`      | who Fluncle is, what the Galaxy is, how to read a Log ID                                                      | secondary |
| `web.newsletter` | `/newsletter` | the newsletter archive + `/newsletter/:number`, one past edition on the web                                   | secondary |
| `web.docs`       | `/docs`       | the Fumadocs developer docs + `/docs/api`, the embedded Scalar API reference                                  | secondary |
| `web.status`     | `/status`     | the public service-health dashboard — uptime per service, recent events                                       | secondary |
| `web.radio`      | `/radio`      | the cycling observation station — Fluncle's spoken field observations on a loop (also at `radio.fluncle.com`) | secondary |
| `web.privacy`    | `/privacy`    | the privacy policy                                                                                            | tertiary  |

### Subdomains — sibling hosts on the same Worker

| Surface            | Host                  | Exposes                                                                                               | Weight    |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------- | --------- |
| `subdomain.galaxy` | `galaxy.fluncle.com`  | the Galaxy game's front door (root rewrites to `/galaxy`)                                             | primary   |
| `subdomain.radio`  | `radio.fluncle.com`   | the observation station (root rewrites to `/radio`)                                                   | secondary |
| `subdomain.found`  | `found.fluncle.com`   | the R2 media zone — each finding's video bundle + mixtape audio + the `/cdn-cgi/media` transform base | tertiary  |
| `subdomain.dig`    | `dig.fluncle.com`     | the delegated DNS zone's host label (see `dns.zone` for the resolver)                                 | tertiary  |
| `subdomain.status` | `status.fluncle.com`  | the planned status host — points at `/status` (not yet wired)                                         | tertiary  |
| `subdomain.onion`  | `…kqo33fyppkqd.onion` | the Tor onion mirror of `www.fluncle.com` — the archive, API, RSS, and MCP over Tor                   | tertiary  |

### API — the public `/api/v1` surface

All `application/json`; the OpenAPI document at `/api/v1/openapi.json` advertises them.

| Surface                 | Route                       | Exposes                                                      | Weight    |
| ----------------------- | --------------------------- | ------------------------------------------------------------ | --------- |
| `api.tracks`            | `/api/v1/tracks`            | the archive as JSON, cursor-paginated (limit max 48, cursor) | primary   |
| `api.track`             | `/api/v1/tracks/:idOrLogId` | one finding or mixtape by Spotify id or Log ID               | secondary |
| `api.tracks.random`     | `/api/v1/tracks/random`     | one finding at random                                        | secondary |
| `api.mixtapes`          | `/api/v1/mixtapes`          | published mixtapes as JSON                                   | secondary |
| `api.search`            | `/api/v1/search`            | Spotify search candidates for submitting a track             | secondary |
| `api.submissions`       | `/api/v1/submissions`       | submit a track for review (POST)                             | secondary |
| `api.newsletter`        | `/api/v1/newsletter`        | subscribe to the newsletter (POST); the editions archive     | secondary |
| `api.stories`           | `/api/v1/stories`           | the Stories payload as JSON                                  | tertiary  |
| `api.radio.now-playing` | `/api/v1/radio/now-playing` | the radio shared-clock now-playing slot                      | tertiary  |
| `api.health`            | `/api/health`               | the liveness probe — the canonical web health check          | tertiary  |

### Feeds — subscribable syndication documents

| Surface         | Route           | Format                  | Exposes                                                               | Weight    |
| --------------- | --------------- | ----------------------- | --------------------------------------------------------------------- | --------- |
| `feed.rss`      | `/rss.xml`      | `application/rss+xml`   | the 25 most recent findings and mixtapes                              | primary   |
| `feed.atom`     | `/atom.xml`     | `application/atom+xml`  | the recent findings and mixtapes as an Atom feed                      | secondary |
| `feed.json`     | `/feed.json`    | `application/feed+json` | the recent findings and mixtapes as a JSON Feed                       | secondary |
| `feed.podcast`  | `/podcast.xml`  | `application/rss+xml`   | the mixtapes as a podcast feed (episode audio on `found.fluncle.com`) | secondary |
| `feed.calendar` | `/calendar.ics` | `text/calendar`         | planned events as an iCalendar feed (Twitch-linked VEVENTs)           | tertiary  |

### Discovery — machine-/crawler-facing maps

| Surface                     | Route                                  | Format                     | Exposes                                                                             | Weight    |
| --------------------------- | -------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- | --------- |
| `discovery.llms`            | `/llms.txt`                            | `text/markdown`            | the plain-language map of the Galaxy for LLMs                                       | primary   |
| `discovery.sitemap`         | `/sitemap.xml`                         | `application/xml`          | the XML sitemap of every public page                                                | secondary |
| `discovery.llms-full`       | `/llms-full.txt`                       | `text/markdown`            | the entire archive in one ingestible markdown document, every finding               | secondary |
| `discovery.openapi`         | `/api/v1/openapi.json`                 | `application/openapi+json` | the public API as an OpenAPI 3.1 document (admin paths excluded)                    | secondary |
| `discovery.robots`          | `/robots.txt`                          | `text/plain`               | the crawl policy + Content-Signal (search/AI-input/AI-train all yes) + sitemap link | tertiary  |
| `discovery.mcp-server-card` | `/.well-known/mcp/server-card.json`    | `application/json`         | the SEP-2127 discovery card for the MCP endpoint                                    | tertiary  |
| `discovery.api-catalog`     | `/.well-known/api-catalog`             | `application/linkset+json` | the RFC 9727 linkset pointing at the machine-readable surfaces                      | tertiary  |
| `discovery.agent-skills`    | `/.well-known/agent-skills/index.json` | `application/json`         | the fluncle-api agent skill index (with the SKILL.md digest)                        | tertiary  |

### MCP — the Model Context Protocol server

| Surface      | Route  | Exposes                                                                                                                                         | Weight  |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `mcp.server` | `/mcp` | the archive as MCP tools (Streamable HTTP, no auth): `list_tracks`, `get_random_track`, `search_tracks`, `submit_track`, `subscribe_newsletter` | primary |

### DNS — the delegated authoritative zone

| Surface    | Command                            | Exposes                                                                                                                                  | Weight   |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `dns.zone` | `dig TXT 004.7.2I.dig.fluncle.com` | a finding's coordinate as a TXT record, plus the special labels `random` and `latest` (apps/dns; not recursive — out-of-zone is REFUSED) | tertiary |

### SSH — the rave terminal

| Surface    | Command                | Exposes                                                                                                                                                                                  | Weight  |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `ssh.rave` | `ssh rave.fluncle.com` | the rave terminal TUI (Enter the Galaxy, Latest bangers, Mixtape archive, Submit, Subscribe, Install CLI, About), plus the deep-register one-shots `ssh rave.fluncle.com latest\|random` | primary |

### CLI — the `fluncle` thin client

| Surface          | Command              | Exposes                                                                                            | Weight    |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| `cli.recent`     | `fluncle recent`     | the latest bangers, newest first (alias `list`)                                                    | primary   |
| `cli.mixtapes`   | `fluncle mixtapes`   | Fluncle's checkpoint sets                                                                          | secondary |
| `cli.open`       | `fluncle open`       | pick a track, open it in Spotify                                                                   | secondary |
| `cli.random`     | `fluncle random`     | the archive throws one back                                                                        | secondary |
| `cli.subscribe`  | `fluncle subscribe`  | subscribe to the Friday newsletter                                                                 | secondary |
| `cli.submit`     | `fluncle submit`     | send a track for review                                                                            | secondary |
| `cli.tracks-get` | `fluncle tracks get` | look up one finding by id or Log ID (group alias `track`)                                          | tertiary  |
| `cli.about`      | `fluncle about`      | Fluncle, and where to find him                                                                     | tertiary  |
| `cli.version`    | `fluncle version`    | print or check the version (`--check` hits the latest GitHub release)                              | tertiary  |
| `cli.admin`      | `fluncle admin`      | the operator/agent command group (hidden): `tracks`, `mixtapes`, `newsletter`, `backfills`, `auth` | hidden    |

### Crons — the on-box Hermes scheduled jobs

Checked by their last-run freshness (not an HTTP hit), so they carry a `cronName` + cadence instead of a URL probe.

| Surface             | Cron job               | Cadence             | Exposes                                                                                                                              | Weight    |
| ------------------- | ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `cron.newsletter`   | `fluncle-newsletter`   | Fri 15:00 Amsterdam | draft + persist the weekly edition, then offer the operator a Discord Send button (the only full-agent cron; send is operator-gated) | secondary |
| `cron.enrich`       | `fluncle-enrich`       | every 5m            | BPM / key / spectral analysis on the box, write-back (`--no-agent`, on-box DSP, zero LLM tokens)                                     | hidden    |
| `cron.context-note` | `fluncle-context-note` | every 5m            | Firecrawl facts → distilled `context_note` + a Texture line (Worker-side Haiku, zero on-box tokens)                                  | hidden    |
| `cron.note`         | `fluncle-note`         | every 10m           | auto-author the editorial `/log` note, fill-empty-only (hybrid: one `claude -p` call; never clobbers an operator note)               | hidden    |
| `cron.observation`  | `fluncle-observation`  | every 60m           | author the recovered-audio script → Worker Cartesia render (hybrid: one `claude -p` call, Worker voice-gates + renders)              | hidden    |
| `cron.backfill`     | `fluncle-backfill`     | every 30m           | Discogs id + Last.fm love catalogue repair (`--no-agent`, Worker HTTP, zero LLM tokens)                                              | hidden    |
| `cron.render`       | `fluncle-render`       | every 60m           | wake the render box → render + ship one finding's video → park (a conductor; never posts to social)                                  | hidden    |
| `cron.healthcheck`  | `fluncle-healthcheck`  | every 10m           | probe each service → Discord-ping on a status flip → POST the `/status` snapshot (`--no-agent`)                                      | hidden    |

## 3. The platform-weight matrix

`SurfaceWeight` is the registry's "how loudly is this presented" ladder — it drives which surfaces lead the homepage dev-row and this doc, and which are real-but-quiet. `surfacesByWeight(weight)` returns each tier in catalog order.

- **`primary`** — the loud front doors; these lead the homepage dev-row and this inventory. `web.home`, `web.log`, `web.mixtapes`, `web.galaxy`, `subdomain.galaxy`, `api.tracks`, `feed.rss`, `discovery.llms`, `mcp.server`, `ssh.rave`, `cli.recent`.
- **`secondary`** — real, advertised, but not headline. The rest of the public web routes (`web.stories`, `web.about`, `web.newsletter`, `web.docs`, `web.status`, `web.radio`), `subdomain.radio`, most of the API (`api.track`, `api.tracks.random`, `api.mixtapes`, `api.search`, `api.submissions`, `api.newsletter`), the secondary feeds (`feed.atom`, `feed.json`, `feed.podcast`), the secondary discovery maps (`discovery.sitemap`, `discovery.llms-full`, `discovery.openapi`), the public CLI verbs (`cli.mixtapes`, `cli.open`, `cli.random`, `cli.subscribe`, `cli.submit`), and the one operator-visible cron `cron.newsletter`.
- **`tertiary`** — low-level details and infrastructure surfaces: `web.privacy`, the infra subdomains (`subdomain.found`, `subdomain.dig`, `subdomain.status`, `subdomain.onion`), the niche API endpoints (`api.stories`, `api.radio.now-playing`, `api.health`), `feed.calendar`, the well-known discovery files (`discovery.robots`, `discovery.mcp-server-card`, `discovery.api-catalog`, `discovery.agent-skills`), `dns.zone`, and the meta CLI commands (`cli.tracks-get`, `cli.about`, `cli.version`).
- **`hidden`** — real and registered but deliberately not advertised (operator/agent-only): `cli.admin` and every cron except the newsletter (`cron.enrich`, `cron.context-note`, `cron.note`, `cron.observation`, `cron.backfill`, `cron.render`, `cron.healthcheck`).

## 4. Adding a surface — the checklist

When Fluncle gains a new reachable surface, the work is small and the fan-out is automatic:

1. **Add the registry entry.** Append one `Surface` to `SURFACES` in `packages/registry/src/index.ts`: a unique `name`, its `kind`, its `weight`, its address (`url` / `route` / `subdomain` / `command`), `exposedContent`, and — where they apply — `apiFormat`, a `probeConfig`, a `discoveryUrl`, and `operatorNotes`. Name it per the cross-surface `verb_noun` convention ([docs/naming-conventions.md](./naming-conventions.md)) so one operation reads the same across CLI / API / MCP / SSH.
2. **It lights up `/status`.** If the entry carries a `probeConfig`, the `fluncle-healthcheck` cron walks it (`statusProbes()`) and it appears on the health dashboard — an HTTP surface is GET-probed, a `cron` surface is checked by its last-run freshness.
3. **It lights up the homepage dev-row.** A `primary`/`secondary` entry (`surfacesByWeight`) joins the row of surfaces the homepage advertises, in its weight tier.
4. **It lights up `llms.txt` and the sitemap.** A public web route / feed / discovery map flows into the crawler- and LLM-facing maps so agents and search engines find it.
5. **It lights up this doc.** Add the row to the matching kind table in §2 and place it in the §3 weight tier. The registry is the source of truth; this doc tracks it.

If a surface is operator/agent-only, give it `weight: "hidden"` so it stays registered (and probeable) without being advertised. If it's a non-CRUD action or a new command, run it past the naming convention's "how to name a new feature" checklist before you pick the `name`.
