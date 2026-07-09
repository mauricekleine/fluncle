# Surfaces Doctrine

The canonical map of every place Fluncle is reachable across the Galaxy — web routes, subdomains, the public API, the feeds, the agent-discovery maps, the delegated DNS zone, the SSH terminal, the MCP server, the CLI, and the on-box Hermes crons — and the checklist for wiring a new one in.

This doc replaces the old `docs/public-surfaces-checklist.md` (a hand-maintained tickbox list that drifted from the code). The decisions it recorded (per-coordinate web subdomains dropped, the `dig` surface that superseded them, the Tor mirror, the data-graph anchors) live on either in the registry itself or in `docs/planning/ROADMAP.md`'s long-tail section.

## 1. The registry is the source of truth

Every surface is **one entry in `@fluncle/registry`** (`packages/registry/src/index.ts`) — a pure, typed catalog (`SURFACES`) plus a few selectors over it (`liveSurfaces`, `surfacesForContext`, `surfacesByWeight`, `surfacesByKind`, `statusProbes`, `cronSurfaces`). It is data, not a route table and not a secrets inventory: internal IPs, op-paths, and credentials never go in it.

The point is that one entry **fans out**. Add a surface to the registry once and every consumer — the `/status` prober, the homepage dev-row, `llms.txt`, the sitemap, and this doc — picks it up from the same list instead of each hand-maintaining a drifting copy. This doc is organized around the registry's own shape: its `SurfaceKind` families (§2) and its per-context `SurfaceWeight` matrix (§3).

One class stays out by design: the **live glass and its phone remote** (`packages/live`, on `:4173` / `:4180`) are LAN-local operator surfaces — reachable only on the show network, never public — so per the live-longform RFC they are intentionally absent from `@fluncle/registry`; the `run_show` orchestrator that raises them registers as a local-exec op instead ([naming-conventions.md §7](./naming-conventions.md#7-local-exec-ops-the-registrys-non-http-tail)).

Each entry carries: a stable `name` (unique, e.g. `web.log`, `api.tracks`), a `kind`, a `weights` matrix (per-context prominence — see §3), the address it lives at (`url` / `route` / `subdomain` / `command`, populated per kind), `exposedContent` (what it serves, in plain words), and — where applicable — `apiFormat`, a `probeConfig` (how `/status` checks it), a `discoveryUrl` (what advertises it), `pending` (pre-staged but dark — see §3.5), and `operatorNotes` (tier, caveats, where the source lives; never secrets).

## 2. The surface inventory, by kind

Generated from the `SURFACES` catalog. Each row is the registry `name`, its address, and what it exposes; the **Weight** column is the surface's prominence in its **home context** — the display context where it most naturally lives (web routes / subdomains / API / feeds / discovery / MCP / DNS rank in `web`; the SSH surface in `ssh`; CLI verbs in `cli`; crons in `status`). The full per-context matrix is §3. Keep this table in step with the catalog when you add or change an entry.

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
| `web.artist`     | `/artist`     | `/artist/:slug` — one artist's page: every published finding from that artist, plus their identity links      | secondary |
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

| Surface                 | Route                       | Exposes                                                                                                | Weight    |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| `api.tracks`            | `/api/v1/tracks`            | the archive as JSON, cursor-paginated (limit max 48, cursor)                                           | primary   |
| `api.track`             | `/api/v1/tracks/:idOrLogId` | one finding or mixtape by Spotify id or Log ID                                                         | secondary |
| `api.tracks.random`     | `/api/v1/tracks/random`     | one finding at random                                                                                  | secondary |
| `api.mixtapes`          | `/api/v1/mixtapes`          | published mixtapes as JSON                                                                             | secondary |
| `api.artists`           | `/api/v1/artists`           | every artist with at least one published finding, finding-count ordered, plus `/api/v1/artists/{slug}` | secondary |
| `api.search`            | `/api/v1/search`            | Spotify search candidates for submitting a track                                                       | secondary |
| `api.submissions`       | `/api/v1/submissions`       | submit a track for review (POST)                                                                       | secondary |
| `api.newsletter`        | `/api/v1/newsletter`        | subscribe to the newsletter (POST); the editions archive                                               | secondary |
| `api.stories`           | `/api/v1/stories`           | the Stories payload as JSON                                                                            | tertiary  |
| `api.radio.now-playing` | `/api/v1/radio/now-playing` | the radio shared-clock now-playing slot                                                                | tertiary  |
| `api.health`            | `/api/health`               | the liveness probe — the canonical web health check                                                    | tertiary  |

### Feeds — subscribable syndication documents

| Surface         | Route           | Format                  | Exposes                                                               | Weight    |
| --------------- | --------------- | ----------------------- | --------------------------------------------------------------------- | --------- |
| `feed.rss`      | `/rss.xml`      | `application/rss+xml`   | the 25 most recent findings and mixtapes                              | primary   |
| `feed.atom`     | `/atom.xml`     | `application/atom+xml`  | the recent findings and mixtapes as an Atom feed                      | secondary |
| `feed.json`     | `/feed.json`    | `application/feed+json` | the recent findings and mixtapes as a JSON Feed                       | secondary |
| `feed.podcast`  | `/podcast.xml`  | `application/rss+xml`   | the mixtapes as a podcast feed (episode audio on `found.fluncle.com`) | secondary |
| `feed.calendar` | `/calendar.ics` | `text/calendar`         | planned events as an iCalendar feed (Twitch-linked VEVENTs)           | tertiary  |

### Discovery — machine-/crawler-facing maps

| Surface                     | Route                                  | Format                     | Exposes                                                                                                                      | Weight    |
| --------------------------- | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- |
| `discovery.llms`            | `/llms.txt`                            | `text/markdown`            | the plain-language map of the Galaxy for LLMs                                                                                | primary   |
| `discovery.sitemap`         | `/sitemap.xml`                         | `application/xml`          | the XML sitemap of every public page                                                                                         | secondary |
| `discovery.llms-full`       | `/llms-full.txt`                       | `text/markdown`            | the entire archive in one ingestible markdown document, every finding                                                        | secondary |
| `discovery.openapi`         | `/api/v1/openapi.json`                 | `application/openapi+json` | the public API as an OpenAPI 3.1 document (admin paths excluded)                                                             | secondary |
| `discovery.robots`          | `/robots.txt`                          | `text/plain`               | the crawl policy + Content-Signal (search/AI-input/AI-train all yes) + sitemap link                                          | tertiary  |
| `discovery.mcp-server-card` | `/.well-known/mcp/server-card.json`    | `application/json`         | the SEP-2127 discovery card for the MCP endpoint                                                                             | tertiary  |
| `discovery.api-catalog`     | `/.well-known/api-catalog`             | `application/linkset+json` | the RFC 9727 linkset pointing at the machine-readable surfaces                                                               | tertiary  |
| `discovery.agent-skills`    | `/.well-known/agent-skills/index.json` | `application/json`         | the fluncle-api agent skill index (with the SKILL.md digest)                                                                 | tertiary  |
| `discovery.oembed`          | `/oembed`                              | `application/json+oembed`  | the oEmbed 1.0 provider — a pasted /log, /mixtapes, or /artist link unfurls as a rich finding card (frames `/embed/<logId>`) | tertiary  |

### MCP — the Model Context Protocol server

The `/mcp` endpoint speaks the full protocol, not just tools: **tools** (verbs), **resources** (the archive as a readable corpus, one URI per coordinate), and **prompts** (Fluncle-voiced starting points). Streamable HTTP, no auth. Resources and prompts are server-MCP only — `navigator.modelContext` (the browser WebMCP surface, `lib/webmcp.ts`) has no resource/prompt primitive, so it mirrors the tool set alone (the browser read path is the `get_track` tool).

| Surface      | Route  | Exposes                                                                                                                                                                                                                                                                                                                                    | Weight  |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `mcp.server` | `/mcp` | **tools**: `list_tracks`, `get_track`, `get_random_track`, `get_status`, `search_tracks`, `submit_track`, `subscribe_newsletter`. **resources**: each finding/mixtape at `fluncle://finding/<logId>` or `fluncle://mixtape/<logId>` (its public `/log` record). **prompts**: `recommend_finding`, `walk_recent_night`, `decode_coordinate` | primary |

### DNS — the delegated authoritative zone

| Surface    | Command                            | Exposes                                                                                                                                  | Weight   |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `dns.zone` | `dig TXT 004.7.2I.dig.fluncle.com` | a finding's coordinate as a TXT record, plus the special labels `random` and `latest` (apps/dns; not recursive — out-of-zone is REFUSED) | tertiary |

### SSH — the rave terminal

| Surface    | Command                | Exposes                                                                                                                                                                                                                | Weight  |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `ssh.rave` | `ssh rave.fluncle.com` | the rave terminal TUI (Enter the Galaxy, Latest bangers, Mixtape archive, Random banger, Submit, Subscribe, Install CLI, System status, About), plus the deep-register one-shots `ssh rave.fluncle.com latest\|random` | primary |

### CLI — the `fluncle` thin client

| Surface          | Command              | Exposes                                                                                            | Weight    |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| `cli.recent`     | `fluncle recent`     | the latest bangers, newest first (alias `list`)                                                    | primary   |
| `cli.mixtapes`   | `fluncle mixtapes`   | Fluncle's checkpoint sets                                                                          | secondary |
| `cli.artists`    | `fluncle artists`    | every artist with at least one published finding (a bare `slug` looks one up)                      | secondary |
| `cli.open`       | `fluncle open`       | pick a track, open it in Spotify                                                                   | secondary |
| `cli.random`     | `fluncle random`     | the archive throws one back                                                                        | secondary |
| `cli.subscribe`  | `fluncle subscribe`  | subscribe to the Friday newsletter                                                                 | secondary |
| `cli.submit`     | `fluncle submit`     | send a track for review                                                                            | secondary |
| `cli.tracks-get` | `fluncle tracks get` | look up one finding by id or Log ID (group alias `track`)                                          | tertiary  |
| `cli.about`      | `fluncle about`      | Fluncle, and where to find him                                                                     | tertiary  |
| `cli.version`    | `fluncle version`    | print or check the version (`--check` hits the latest GitHub release)                              | tertiary  |
| `cli.admin`      | `fluncle admin`      | the operator/agent command group (hidden): `tracks`, `mixtapes`, `newsletter`, `backfills`, `auth` | hidden    |

### Browser extensions — vendor-store surfaces

Listings on a third-party store, not pages we host. Their uptime is the store's, so they carry no `/status` probe.

| Surface          | Store URL                                                           | Exposes                                                                                                                                                                  | Weight    |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `extension.lens` | `chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk` | Fluncle Lens — the Chrome extension that finds `fluncle://` coordinates on any page and links each to its `/log/<coord>` finding (with a hover card from the public API) | secondary |

### Crons — the on-box Hermes scheduled jobs

Checked by their last-run freshness (not an HTTP hit), so they carry a `cronName` + cadence instead of a URL probe.

| Surface               | Cron job                 | Cadence             | Exposes                                                                                                                              | Weight    |
| --------------------- | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `cron.newsletter`     | `fluncle-newsletter`     | Fri 15:00 Amsterdam | draft + persist the weekly edition, then offer the operator a Discord Send button (the only full-agent cron; send is operator-gated) | secondary |
| `cron.enrich`         | `fluncle-enrich`         | every 5m            | BPM / key / spectral analysis on the box, write-back (`--no-agent`, on-box DSP, zero LLM tokens)                                     | hidden    |
| `cron.context-note`   | `fluncle-context-note`   | every 5m            | Firecrawl facts → distilled `context_note` + a Texture line (Worker-side Haiku, zero on-box tokens)                                  | hidden    |
| `cron.note`           | `fluncle-note`           | every 10m           | auto-author the editorial `/log` note, fill-empty-only (hybrid: one `claude -p` call; never clobbers an operator note)               | hidden    |
| `cron.observation`    | `fluncle-observation`    | every 60m           | author the recovered-audio script → Worker Cartesia render (hybrid: one `claude -p` call, Worker voice-gates + renders)              | hidden    |
| `cron.backfill`       | `fluncle-backfill`       | every 30m           | Discogs id + Last.fm love catalogue repair (`--no-agent`, Worker HTTP, zero LLM tokens)                                              | hidden    |
| `cron.social-capture` | `fluncle-social-capture` | every 10m           | capture the YouTube/TikTok post URLs Postiz withholds on create → write back (`--no-agent`, Worker HTTP)                             | hidden    |
| `cron.clip-drip`      | `fluncle-clip-drip`      | every 20m           | post the due, cut clips to Instagram on a jittered ~daily cadence via Postiz (`--no-agent`, Worker HTTP; kill-switch aware)          | hidden    |
| `cron.render`         | `fluncle-render`         | every 60m           | wake the render box → render + ship one finding's video → park (a conductor; never posts to social)                                  | hidden    |
| `cron.healthcheck`    | `fluncle-healthcheck`    | every 10m           | probe each service → Discord-ping on a status flip → POST the `/status` snapshot (a rave-02 host systemd timer, not a gateway cron)  | hidden    |
| `cron.backup`         | `fluncle-backup`         | every 24h           | dump the prod DB → gzip → a PRIVATE R2 bucket (owned off-site backup) + prune to 30 daily / 12 monthly (`--no-agent`, zero tokens)   | secondary |

## 3. The per-context weight matrix

Weight is **per display context**, not global. A surface can be loud in one place and quiet (or absent) in another: the Galaxy game leads the web homepage but sits mid-menu in the SSH terminal; a CLI verb has no web presence at all. So `weight` is a sparse matrix — `weights: Partial<Record<SurfaceContext, SurfaceWeight>>` — keyed by the surface that does the displaying.

A **display context** is one of the surfaces that itself acts as a menu / nav / entry point ranking _other_ surfaces:

- **`web`** — the `www.fluncle.com` homepage nav + dev-row (the browser front door). Ranks the human-web surfaces a visitor browses to.
- **`ssh`** — the rave terminal menu (`ssh rave.fluncle.com`, the keyboard front door). Ranks what the TUI offers and its deep-link one-shots.
- **`cli`** — the `fluncle` CLI's own command surface (`fluncle --help` / the about screen). Ranks the CLI verbs against each other.
- **`status`** — the `/status` health dashboard + the MCP `get_status` summary. Ranks the probed services by how prominently they head the board.

The weight ladder within a context is unchanged — **`primary`** (the loud front doors that lead that context), **`secondary`** (real, advertised, not headline), **`tertiary`** (low-level / infrastructure), **`hidden`** (registered but deliberately not advertised there, operator/agent-only). A **blank cell means the surface is not displayed in that context** (an absent key in the matrix).

`surfacesForContext(ctx)` returns the surfaces a context displays, sorted loudest-first; `surfacesByWeight(ctx, weight)` returns one tier within a context.

| Surface                     | `web`     | `ssh`     | `cli`     | `status`  |
| --------------------------- | --------- | --------- | --------- | --------- |
| `web.home`                  | primary   |           |           |           |
| `web.log`                   | primary   | secondary |           |           |
| `web.mixtapes`              | primary   | secondary |           |           |
| `web.galaxy`                | primary   | secondary |           |           |
| `web.stories`               | secondary |           |           |           |
| `web.about`                 | secondary | tertiary  |           |           |
| `web.newsletter`            | secondary |           |           |           |
| `web.docs`                  | secondary |           |           |           |
| `web.status`                | secondary |           |           | primary   |
| `web.radio`                 | secondary |           |           |           |
| `web.artist`                | secondary | secondary |           |           |
| `web.privacy`               | tertiary  |           |           |           |
| `subdomain.galaxy`          | primary   | secondary |           |           |
| `subdomain.radio`           | secondary |           |           |           |
| `subdomain.found`           | tertiary  |           |           | tertiary  |
| `subdomain.dig`             | tertiary  |           |           |           |
| `subdomain.status`          | tertiary  |           |           | tertiary  |
| `subdomain.onion`           | tertiary  |           |           | tertiary  |
| `api.tracks`                | primary   |           |           | secondary |
| `api.track`                 | secondary |           |           |           |
| `api.tracks.random`         | secondary |           |           |           |
| `api.mixtapes`              | secondary |           |           |           |
| `api.artists`               | secondary |           |           |           |
| `api.search`                | secondary |           |           |           |
| `api.submissions`           | secondary |           |           |           |
| `api.newsletter`            | secondary |           |           |           |
| `api.stories`               | tertiary  |           |           |           |
| `api.radio.now-playing`     | tertiary  |           |           |           |
| `api.health`                | tertiary  |           |           | tertiary  |
| `feed.rss`                  | primary   |           |           |           |
| `feed.atom`                 | secondary |           |           |           |
| `feed.json`                 | secondary |           |           |           |
| `feed.podcast`              | secondary |           |           |           |
| `feed.calendar`             | tertiary  |           |           |           |
| `discovery.llms`            | primary   |           |           |           |
| `discovery.sitemap`         | secondary |           |           |           |
| `discovery.llms-full`       | secondary |           |           |           |
| `discovery.openapi`         | secondary |           |           |           |
| `discovery.robots`          | tertiary  |           |           |           |
| `discovery.mcp-server-card` | tertiary  |           |           |           |
| `discovery.api-catalog`     | tertiary  |           |           |           |
| `discovery.agent-skills`    | tertiary  |           |           |           |
| `discovery.oembed`          | tertiary  |           |           |           |
| `mcp.server`                | primary   |           |           |           |
| `dns.zone`                  | tertiary  |           |           | tertiary  |
| `ssh.rave`                  | primary   | primary   |           | secondary |
| `cli.recent`                | tertiary  |           | primary   |           |
| `cli.mixtapes`              |           |           | secondary |           |
| `cli.artists`               |           |           | secondary |           |
| `cli.open`                  |           |           | secondary |           |
| `cli.random`                |           |           | secondary |           |
| `cli.subscribe`             |           |           | secondary |           |
| `cli.submit`                |           |           | secondary |           |
| `cli.tracks-get`            |           |           | tertiary  |           |
| `cli.about`                 |           |           | tertiary  |           |
| `cli.version`               |           |           | tertiary  |           |
| `cli.admin`                 |           |           | hidden    |           |
| `extension.lens`            | secondary |           |           |           |
| `cron.newsletter`           |           |           |           | secondary |
| `cron.enrich`               |           |           |           | hidden    |
| `cron.context-note`         |           |           |           | hidden    |
| `cron.note`                 |           |           |           | hidden    |
| `cron.observation`          |           |           |           | hidden    |
| `cron.backfill`             |           |           |           | hidden    |
| `cron.social-capture`       |           |           |           | hidden    |
| `cron.clip-drip`            |           |           |           | hidden    |
| `cron.render`               |           |           |           | hidden    |
| `cron.healthcheck`          |           |           |           | hidden    |

A surface is operator/agent-only where its only display weight is `hidden` (`cli.admin` in `cli`; every cron but the newsletter in `status`) — registered (and probeable) without being advertised.

## 3.5. Pre-staging a surface — the `pending` (dark) gate

`hidden` and `pending` are different shapes of "not loud." A `hidden` weight is a **live** surface that one context deliberately doesn't headline (it still probes, still serves, still answers). A surface marked **`pending: true`** is **not live at all yet**: registered (so it is reviewed and one field-flip away) but **DARK everywhere** — `liveSurfaces()` drops it, so every selector (`surfacesForContext`, `surfacesByWeight`, `surfacesByKind`, `statusProbes`, `cronSurfaces`) and every raw-catalog consumer that reads `liveSurfaces()` (the MCP `get_status` labels, the CLI status labels) skips it. It appears on no menu, no `/status` probe, the dev-row, `llms.txt`, or the sitemap, and it stays out of the §2/§3 tables until it goes live.

Use it to land a surface **ahead of an external gate** so the post-approval fan-out is a single, reviewed, no-other-edits flip. **Fluncle Lens** (`extension.lens`, the `apps/extension` Chrome extension) was the first such entry: it sat `pending: true` through Chrome Web Store review, then went **live on 2026-06-29** by exactly this flip — drop `pending`, swap the placeholder `url` for the store's assigned listing URL (`chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk`), and add its §2/§3 rows — and the menus, the dev-row, and the MCP + CLI status labels lit up at once. (A vendor store listing is not one of our own health-probeable endpoints, so it carries no `probeConfig`.)

## 4. Adding a surface — the checklist

When Fluncle gains a new reachable surface, the work is small and the fan-out is automatic:

1. **Add the registry entry.** Append one `Surface` to `SURFACES` in `packages/registry/src/index.ts`: a unique `name`, its `kind`, its per-context `weights` matrix (a weight for each context that displays it — see §3; omit a context to leave it absent there), its address (`url` / `route` / `subdomain` / `command`), `exposedContent`, and — where they apply — `apiFormat`, a `probeConfig`, a `discoveryUrl`, and `operatorNotes`. Name it per the cross-surface `verb_noun` convention ([docs/naming-conventions.md](./naming-conventions.md)) so one operation reads the same across CLI / API / MCP / SSH.
2. **It lights up `/status`.** If the entry carries a `probeConfig`, the `fluncle-healthcheck` cron walks it (`statusProbes()`) and it appears on the health dashboard — an HTTP surface is GET-probed, a `cron` surface is checked by its last-run freshness.
3. **It lights up a context's menu.** Give it a weight in the contexts that should show it: `weights.web` joins the homepage dev-row, `weights.ssh` the rave terminal menu, `weights.cli` the CLI help surface, `weights.status` the health board's ranking. `surfacesForContext(ctx)` returns that context's surfaces loudest-first.
4. **It lights up `llms.txt` and the sitemap.** A public web route / feed / discovery map flows into the crawler- and LLM-facing maps so agents and search engines find it.
5. **It lights up this doc.** Add the row to the matching kind table in §2 (its home-context weight) and to the per-context matrix in §3. The registry is the source of truth; this doc tracks it.

If a surface is operator/agent-only, give it only a `hidden` weight in the relevant context (e.g. `weights: { cli: "hidden" }`) so it stays registered (and probeable) without being advertised. If a surface exists but is **gated behind an external approval** (a store review, a DNS cutover), add it now with `pending: true` so it is reviewed but dark, then flip the flag the day it goes live (see §3.5) — fill in its real `weights`/`probeConfig`/§2-§3 rows in the same flip. If it's a non-CRUD action or a new command, run it past the naming convention's "how to name a new feature" checklist before you pick the `name`.
