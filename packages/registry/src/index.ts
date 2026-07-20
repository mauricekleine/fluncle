// The Fluncle surfaces registry — the single, in-code source of truth for every
// place Fluncle is reachable across the Galaxy: web routes, subdomains, the public
// API, the feeds, the agent-discovery surfaces, the delegated DNS zone, the SSH
// terminal, the MCP server, the CLI, and the on-box Hermes crons.
//
// It is PURE DATA (no runtime side effects, no I/O): just a typed catalog plus a
// few selectors over it. It is consumed across the app — the `/status` probe, the
// CLI `status` command, the MCP `get_status` tool, the homepage dev-row, llms.txt,
// the sitemap, and the surfaces-doctrine doc all read the same list instead of each
// hand-maintaining a drifting copy. When a new surface ships, add it here once;
// every consumer picks it up.
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
 * - `extension`  a browser extension on a vendor store (Fluncle Lens, Chrome Web Store)
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
  | "cron"
  | "extension";

/**
 * How loudly a surface is presented IN A GIVEN CONTEXT. `primary` surfaces lead
 * that context's menu/nav; `hidden` ones are real and registered but deliberately
 * not advertised there (operator/agent-only or a low-level discovery detail).
 *
 * Weight is per-display-context, not global: a surface can be `primary` on the web
 * homepage yet `secondary` in the SSH terminal, or absent from one context while
 * loud in another (see `SurfaceContext` and `Surface.weights`).
 */
export type SurfaceWeight = "primary" | "secondary" | "tertiary" | "hidden";

/**
 * A DISPLAY CONTEXT: one of the surfaces that itself acts as a menu / nav / entry
 * point ranking OTHER surfaces. A surface's prominence is relative to where it is
 * shown, so weight is keyed by context. The same finding-archive route can lead the
 * web homepage while sitting mid-menu in the SSH terminal.
 *
 * - `web`     the www.fluncle.com homepage nav + dev-row — the browser front door.
 *             Ranks the human-web surfaces a visitor browses to (routes, the Galaxy,
 *             radio, the feeds/discovery a curious dev would notice).
 * - `ssh`     the rave terminal menu (ssh rave.fluncle.com) — the keyboard front
 *             door. Ranks what the TUI offers (Latest, Mixtapes, Submit,
 *             Subscribe, Install CLI, About) and the deep-link one-shots.
 * - `cli`     the `fluncle` CLI's own command surface — how loudly each verb is
 *             presented in `fluncle --help` / the about screen. Ranks the CLI verbs
 *             against each other (`recent` leads; `admin` is hidden).
 * - `status`  the `/status` health dashboard + the MCP `get_status` summary. Ranks
 *             the probed services by how prominently they head the board (the core
 *             web/db/media services lead; the quiet crons trail).
 */
export type SurfaceContext = "web" | "ssh" | "cli" | "status";

/**
 * The per-context presentation of one surface: its weight in each context that
 * displays it. SPARSE — an absent key means the surface is NOT displayed in that
 * context (e.g. an on-box cron has no `web`/`ssh`/`cli` entry; a CLI verb has no
 * `web` entry). At least one key should be present for any surface meant to surface
 * somewhere; a wholly-internal surface may legitimately carry an empty matrix.
 */
export type SurfaceWeights = Partial<Record<SurfaceContext, SurfaceWeight>>;

/**
 * A wall-clock cron schedule in a named IANA timezone — mirrors a systemd `OnCalendar`
 * for the crons that fire at a FIXED local time (the 01:00 audit, the Friday newsletter)
 * rather than on a rolling interval. It lets `/status` compute the TRUE next fire, DST
 * and all, instead of the coarse `lastProbe + cadence` estimate an interval cron gets.
 * Keep it in lockstep with the unit file's `OnCalendar` (the source of truth is the box).
 */
export type CronSchedule = {
  /** Local fire time as `HH:MM`, 24h, in `tz` — e.g. "01:00", "15:00". */
  time: string;
  /** The IANA timezone the wall-clock `time` is expressed in, e.g. "Europe/Amsterdam". */
  tz: string;
  /** Weekday for a weekly schedule (0=Sun … 6=Sat, matching cron/systemd Fri=5); omit for daily. */
  weekday?: number;
};

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
  /**
   * A fixed wall-clock schedule (kind `cron` only), for a cron that fires at a set local
   * time rather than on an interval — so `/status` shows the real next fire, not a cadence
   * estimate. Omit for interval crons (every-5m etc.); their estimate is honest.
   */
  schedule?: CronSchedule;
  /** How long the prober waits before calling a check failed, in ms. */
  timeoutMs?: number;
};

/** One Fluncle surface. URL/route/command/subdomain are populated per `kind`. */
export type Surface = {
  /** A stable, human-readable id, unique across the catalog (e.g. "web.log", "api.tracks"). */
  name: string;
  kind: SurfaceKind;
  /**
   * The human display NAME for this surface on the `/status` health board (e.g.
   * "Audio enrichment", "Weekly newsletter"). REQUIRED for a status-visible surface
   * (every `cron` surface `cronSurfaces()`/`statusProbes()` yields), enforced by the
   * registry test — so a cron added here can never render as a raw `cron.<slug>`.
   * Absent for a surface that never reaches `/status` (a CLI verb, a plain web route).
   */
  title?: string;
  /**
   * A quiet one-line subtitle for this surface's `/status` row — a plain, PUBLIC-safe
   * description of what it does (the register of "writes each finding's editorial
   * note"). REQUIRED alongside `title` for a status-visible surface (enforced by the
   * registry test). PUBLIC: it shows on the page, so it names no internal host, IP, or
   * op-path. Absent for a surface that never reaches `/status`.
   */
  statusDescription?: string;
  /**
   * How loudly this surface is presented, PER DISPLAY CONTEXT. Sparse: a key is
   * present only for a context that displays the surface; an absent key means
   * "not shown there". See `SurfaceContext` and `surfacesForContext`.
   */
  weights: SurfaceWeights;
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
  /**
   * PRE-STAGED but not yet live: registered in the catalog (so it is reviewed and
   * one field-flip away) yet DARK everywhere. A `pending` surface is excluded from
   * every selector — `surfacesForContext`, `surfacesByWeight`, `surfacesByKind`,
   * `statusProbes`, `cronSurfaces` — so it appears on no context menu, no `/status`
   * probe, the dev-row, llms.txt, or the sitemap, and the raw `SURFACES`-iterating
   * consumers (the MCP `get_status` labels, the CLI status labels) skip it too via
   * `liveSurfaces()`. Delete the flag (or set it false) the moment the surface goes
   * live and every consumer picks it up at once. Used to land a surface ahead of an
   * external gate (e.g. a Chrome Web Store review) so the fan-out is a single,
   * reviewed, no-other-edits flip on approval.
   */
  pending?: boolean;
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
    weights: { web: "primary" },
  },
  {
    exposedContent: [
      "the log index — every finding's coordinate page",
      "/log/:logId — one finding's permanent home (the Log ID resolves here)",
      "/:coordinate — a bare coordinate typed at the root (the form on a video frame) 301s here",
    ],
    kind: "web_route",
    name: "web.log",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/log",
    url: `${SITE}/log`,
    weights: { ssh: "secondary", web: "primary" },
  },
  {
    exposedContent: [
      "Fluncle's Logbook — the voyage as a first-person travelogue, one entry per sector-day",
      "/logbook/:sector — one day written up, the findings inlined as photos",
    ],
    kind: "web_route",
    name: "web.logbook",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/logbook",
    url: `${SITE}/logbook`,
    weights: { ssh: "tertiary", web: "primary" },
  },
  {
    exposedContent: ["Fluncle's own DJ mixtapes — each a checkpoint set with an F-marked Log ID"],
    kind: "web_route",
    name: "web.mixtapes",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/mixtapes",
    url: `${SITE}/mixtapes`,
    weights: { ssh: "secondary", web: "primary" },
  },
  {
    exposedContent: [
      "the free mixing tool — name artists you like, and Fluncle ranks what mixes in clean next from the whole archive; chain a set and share it as a link",
    ],
    kind: "web_route",
    name: "web.mix",
    operatorNotes:
      "PUBLIC-CAPABLE, gated by a SELF-LIFTING DEPTH MEASUREMENT (not admin auth). The old ~250-finding / admin gate is gone: `/mix` now measures the live archive on every load (`getMixChainDepth` — can the median track reach a full set + rail by a named harmonic move?) and opens to the world on its own the day the catalogue lands enough keyed depth. Until then a stranger is redirected home and the operator still gets in to dogfood. This entry stays `pending` (dark to the dev-row, llms.txt, the sitemap, /status) ONLY so we do not advertise a URL that still redirects — the flip is: confirm the depth gate has opened in prod, remove `pending`, announce. The web weight is pre-set, so the flip needs no other change. No probeConfig — a closed gate 302s a bare GET, which would read as a false 'down'.",
    pending: true,
    route: "/mix",
    url: `${SITE}/mix`,
    weights: { web: "secondary" },
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
    weights: { web: "secondary" },
  },
  {
    exposedContent: ["who Fluncle is, what the Galaxy is, how to read a Log ID"],
    kind: "web_route",
    name: "web.about",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/about",
    url: `${SITE}/about`,
    weights: { ssh: "tertiary", web: "secondary" },
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
    weights: { web: "secondary" },
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
    weights: { web: "secondary" },
  },
  {
    exposedContent: ["the public service-health dashboard — uptime per service, recent events"],
    kind: "web_route",
    name: "web.status",
    operatorNotes:
      "status.fluncle.com rewrites its root here (see the router rewrite + the subdomain.status surface). The fluncle-healthcheck cron POSTs its snapshots to the agent-tier record_health op that this page reads.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/status",
    url: `${SITE}/status`,
    weights: { status: "primary", web: "secondary" },
  },
  {
    exposedContent: [
      "the public reach page — Fluncle's numbers across every platform over time (the crew aboard + how far the findings reached), grouped as audience/reach, no KPI hero",
    ],
    kind: "web_route",
    name: "web.reach",
    operatorNotes:
      "Reads the append-only platform_stats ledger via the public list_platform_stats op (a record_health noun-swap). Every number is already public on its own platform, so the read is anonymous. Loader-only, no react-query. The grouping taxonomy + per-platform display labels live in the PAGE, never the server (the rows stay raw).",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/reach",
    url: `${SITE}/reach`,
    weights: { status: "secondary", web: "secondary" },
  },
  {
    exposedContent: ["the Galaxy game — the 8-bit fly-to-every-banger arcade front door"],
    kind: "web_route",
    name: "web.galaxy",
    operatorNotes: "Reachable at galaxy.fluncle.com, whose root the router rewrites to /galaxy.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/galaxy",
    url: `${SITE}/galaxy`,
    weights: { ssh: "secondary", web: "primary" },
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
    weights: { web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/artists — one A–Z index of every drum & bass artist Fluncle holds",
      "/artist/:slug — one artist's page: its findings, its identity links, and the rest of its catalogue",
    ],
    kind: "web_route",
    name: "web.artist",
    operatorNotes:
      "Slug is real-name kebab-case (e.g. /artist/dbridge). Read-only; an artist earns a page on its CONTENT exactly as a label/album does — a row renders (a findings-free discovered artist included), a slug with no row 404s, and a page below the thin-content floor renders noindex + stays out of the sitemap (the ARTIST_INDEX_MIN_FINDINGS precedent). No probeConfig — the route is slug-parameterized, so there is no fixed URL to GET-probe.",
    route: "/artist",
    url: `${SITE}/artist`,
    weights: { ssh: "secondary", web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/labels — one A–Z index of every drum & bass record label Fluncle holds",
      "/label/:slug — one label: its findings, the artists on it, and the rest of its catalogue",
    ],
    kind: "web_route",
    name: "web.labels",
    operatorNotes:
      "The label half of the graph (log ↔ artist ↔ label ↔ album). The INDEX is probeable (always 200); the slug page is not, so the probe targets /labels. /labels is ONE unified A–Z index of every label Fluncle holds (certified lit, catalogue unlit), paged behind ?page=N. A label below the renderable-track floor renders noindex + stays out of the sitemap (the ARTIST_INDEX_MIN_FINDINGS precedent). The page is BLIND to the label's crawl seed_state — that is crawl scope, never storage (docs/label-entity.md); the operator's ruling station is /admin/labels.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/labels",
    url: `${SITE}/labels`,
    weights: { web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/albums — one alphabetical index of every drum & bass album Fluncle holds",
      "/album/:slug — one record: its findings, its artists, its label, and the rest of its tracklist",
    ],
    kind: "web_route",
    name: "web.albums",
    operatorNotes:
      "The album half of the graph, and the node that closes it: the album page carries the album → label edge (a link, plus `albumRelease.recordLabel` in its MusicAlbum JSON-LD). The INDEX is probeable (always 200); the slug page is not. /albums is ONE unified alphabetical index of every record Fluncle holds (certified lit, catalogue unlit), paged behind ?page=N; a crawl-minted findings-free album is PUBLIC on its content — a row renders its page, a below-floor page renders noindex + stays out of the sitemap, like a discovered label (docs/album-entity.md).",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/albums",
    url: `${SITE}/albums`,
    weights: { web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/fresh — what just came out: every drum & bass track released in the trailing 30-day window, freshest first, findings in full voice and the quieter rows in the unlit register",
    ],
    kind: "web_route",
    name: "web.fresh",
    operatorNotes:
      "The new-releases lens over the whole archive — the SEO answer to 'new dnb releases', a weekly-refreshed query. Orders by tracks.release_date (when a tune CAME OUT), never findings.added_at (when Fluncle FOUND it) — the two are unrelated, and the copy never claims he found these. A HUB, so it is always indexable + listed unconditionally in the sitemap (like /albums), never the per-detail thin-content gate. The window read rides the tracks_release_date_idx btree so it stays a bounded range scan as the catalogue grows (lib/server/fresh.ts). The INDEX is always-200, so it is HTTP-probeable.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/fresh",
    url: `${SITE}/fresh`,
    weights: { web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/tracks — the whole list: every track Fluncle holds (certified findings + the wider catalogue), newest release first, filterable by release year, tempo, key, label, and galaxy",
    ],
    kind: "web_route",
    name: "web.tracks",
    operatorNotes:
      "The top-level track index — the whole archive as one browse list, findings in full voice and the catalogue rows in the unlit register (DESIGN.md). Ordered by tracks.release_date (what came out), never findings.added_at (the Found Rule), numbered-paginated (?page=N) over the tracks_release_date_idx btree with a quiet YEAR fast lane, so a crawler with no JS walks the whole list (lib/server/tracks-hub.ts). The filter params MIRROR the search vocabulary verbatim (yearMin/yearMax, bpmMin/bpmMax, key, label; galaxy is the one extension). The bare HUB is always indexable + in the sitemap, each page self-canonical; ANY filter param present flips it to noindex, and paged bare URLs stay out of the sitemap. The INDEX is always-200, so it is HTTP-probeable.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/tracks",
    url: `${SITE}/tracks`,
    weights: { web: "secondary" },
  },
  {
    exposedContent: [
      "/galaxies — the browse-by-feel lens: the archive grouped into operator-named sonic galaxies (k-means over the MuQ audio embedding space)",
      "/galaxies/:slug — one galaxy: its findings core-first, plus the adjacent galaxies by sound",
    ],
    kind: "web_route",
    name: "web.galaxies",
    operatorNotes:
      "The public sonic-cluster lens (browse-by-feel RFC). Distinct from the game's /galaxy + galaxy.fluncle.com. No probeConfig — the launch gate 404s the index until the operator has NAMED the whole map, so there is no always-200 URL to GET-probe; the api.galaxies op (always 200, empty list pre-launch) is the probe surface. A galaxy below the member floor renders noindex. The rave terminal carries a galaxies browse screen (ssh weight), and llms.txt advertises the lens once the map is named.",
    route: "/galaxies",
    url: `${SITE}/galaxies`,
    weights: { ssh: "secondary", web: "secondary" },
  },
  {
    exposedContent: ["the privacy policy"],
    kind: "web_route",
    name: "web.privacy",
    route: "/privacy",
    url: `${SITE}/privacy`,
    weights: { web: "tertiary" },
  },
  {
    exposedContent: ["the terms of use"],
    kind: "web_route",
    name: "web.terms",
    route: "/terms",
    url: `${SITE}/terms`,
    weights: { web: "tertiary" },
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
    weights: { ssh: "secondary", web: "primary" },
  },
  {
    exposedContent: ["the observation station (root rewrites to /radio)"],
    kind: "subdomain",
    name: "subdomain.radio",
    operatorNotes: "Isomorphic host-rewrite in apps/web router so SSR + hydration agree.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "radio.fluncle.com",
    url: "https://radio.fluncle.com",
    weights: { web: "secondary" },
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
    weights: { status: "tertiary", web: "tertiary" },
  },
  {
    exposedContent: ["the delegated DNS zone's host label (see the dns surface for the resolver)"],
    kind: "subdomain",
    name: "subdomain.dig",
    operatorNotes: "The zone is served by apps/dns; see the `dns.zone` surface.",
    subdomain: "dig.fluncle.com",
    url: "https://dig.fluncle.com",
    weights: { web: "tertiary" },
  },
  {
    exposedContent: ["the status host — its root rewrites to /status"],
    kind: "subdomain",
    name: "subdomain.status",
    operatorNotes:
      "Isomorphic host-rewrite in apps/web router (input/output) so SSR + hydration agree. The DNS record (status.fluncle.com → the Worker) is the remaining operator step.",
    subdomain: "status.fluncle.com",
    url: "https://status.fluncle.com",
    weights: { status: "tertiary", web: "tertiary" },
  },
  {
    exposedContent: [
      "the Tor onion mirror of www.fluncle.com — the archive, API, RSS, and MCP over Tor",
    ],
    kind: "subdomain",
    name: "subdomain.onion",
    operatorNotes:
      "An onionspray mirror. Advertised via Tor Browser's Onion-Location pill. Probed on /status as service `onion`.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion",
    url: "http://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion",
    weights: { status: "tertiary", web: "tertiary" },
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
    weights: { status: "secondary", web: "primary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["one finding or mixtape by Spotify id or Log ID"],
    kind: "api",
    name: "api.track",
    route: "/api/v1/tracks/:idOrLogId",
    url: `${SITE}/api/v1/tracks/:idOrLogId`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["one finding at random"],
    kind: "api",
    name: "api.tracks.random",
    route: "/api/v1/tracks/random",
    url: `${SITE}/api/v1/tracks/random`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    // Ordered by tracks.release_date, NOT findings.added_at — "what just came OUT", the release-date
    // twin of the found-date /api/v1/tracks feed. Uncertified rows carry no coordinate (Unlit Rule).
    exposedContent: [
      "what just came out — newest drum & bass releases over a 30-day window, flat (limit max 100)",
    ],
    kind: "api",
    name: "api.fresh",
    route: "/api/v1/tracks/fresh",
    url: `${SITE}/api/v1/tracks/fresh`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["published mixtapes as JSON"],
    kind: "api",
    name: "api.mixtapes",
    route: "/api/v1/mixtapes",
    url: `${SITE}/api/v1/mixtapes`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "every album in the archive, alphabetical, paginated, as JSON",
      "/api/v1/albums/{slug} — one album's identity, cover, and counts, as JSON",
    ],
    kind: "api",
    name: "api.albums",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/albums",
    url: `${SITE}/api/v1/albums`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "every artist in the archive, alphabetical, paginated, as JSON",
      "/api/v1/artists/{slug} — one artist's identity, finding count, and track count, as JSON",
    ],
    kind: "api",
    name: "api.artists",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/artists",
    url: `${SITE}/api/v1/artists`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "every label in the archive, alphabetical, paginated, as JSON",
      "/api/v1/labels/{slug} — one label's identity, lineage, and counts, as JSON",
    ],
    kind: "api",
    name: "api.labels",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/labels",
    url: `${SITE}/api/v1/labels`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "every named sonic galaxy with its derived member count, as JSON (empty until the map is fully named)",
      "/api/v1/galaxies/{slug} — one galaxy + its findings, core-first, paginated",
    ],
    kind: "api",
    name: "api.galaxies",
    operatorNotes:
      "The public reads behind the browse-by-feel lens (list_galaxies / get_galaxy). Always 200 — behind the launch gate the list is empty and a slug 404s, so it probes green pre-launch and lights up when the map is fully named.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/galaxies",
    url: `${SITE}/api/v1/galaxies`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["Spotify search candidates for submitting a track"],
    kind: "api",
    name: "api.search",
    route: "/api/v1/search",
    url: `${SITE}/api/v1/search`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "search Fluncle's archive: a coordinate (004.7.2I), an artist/label/album name, a bare word (FTS5), or a natural-language query",
      "sonic search — 'tracks that sound like <a real track>', ranked by MuQ embedding distance",
    ],
    kind: "api",
    name: "api.search.archive",
    operatorNotes:
      "The public read behind the ⌘K dialog (search_archive), and the primary navigation once the archive is deep. Four resolution tiers; only the fourth reaches an LLM (OpenRouter, 3s deadline) and it emits FILTERS, never rows. With no OPENROUTER_API_KEY it degrades to full-text and still answers — so it probes green unprovisioned.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/search/archive",
    url: `${SITE}/api/v1/search/archive?q=netsky`,
    weights: { web: "primary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["submit a track for review (POST)"],
    kind: "api",
    name: "api.submissions",
    route: "/api/v1/submissions",
    url: `${SITE}/api/v1/submissions`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["subscribe to the newsletter (POST); the editions archive"],
    kind: "api",
    name: "api.newsletter",
    route: "/api/v1/newsletter",
    url: `${SITE}/api/v1/newsletter`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["the Stories payload as JSON"],
    kind: "api",
    name: "api.stories",
    route: "/api/v1/stories",
    url: `${SITE}/api/v1/stories`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: ["the radio shared-clock now-playing slot"],
    kind: "api",
    name: "api.radio.now-playing",
    route: "/api/v1/radio/now-playing",
    url: `${SITE}/api/v1/radio/now-playing`,
    weights: { web: "tertiary" },
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
    weights: { status: "tertiary", web: "tertiary" },
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
    weights: { web: "primary" },
  },
  {
    apiFormat: "application/atom+xml",
    exposedContent: ["the recent findings and mixtapes as an Atom feed"],
    kind: "feed",
    name: "feed.atom",
    route: "/atom.xml",
    url: `${SITE}/atom.xml`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/feed+json",
    exposedContent: ["the recent findings and mixtapes as a JSON Feed"],
    kind: "feed",
    name: "feed.json",
    route: "/feed.json",
    url: `${SITE}/feed.json`,
    weights: { web: "secondary" },
  },
  {
    // The RELEASE-date syndication twins — what just came OUT (not what Fluncle found). Uncertified
    // catalogue rows ride along linking out to Spotify only, no coordinate (the Unlit Rule).
    apiFormat: "application/rss+xml",
    exposedContent: [
      "the newest drum & bass releases over a 30-day window, as RSS (release-dated, not found-dated)",
    ],
    kind: "feed",
    name: "feed.fresh.rss",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/fresh.xml",
    url: `${SITE}/fresh.xml`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/feed+json",
    exposedContent: [
      "the newest drum & bass releases over a 30-day window, as a JSON Feed (release-dated)",
    ],
    kind: "feed",
    name: "feed.fresh.json",
    route: "/fresh.json",
    url: `${SITE}/fresh.json`,
    weights: { web: "secondary" },
  },
  {
    // The per-ENTITY release feeds — /fresh.xml narrowed to one artist / one label: what just came
    // OUT from that entity, over the same 30-day window. LITERAL (only the entity's own tracks,
    // never a widening to similar artists); uncertified catalogue rows ride along linking out to
    // Spotify only, no coordinate (the Unlit Rule). Advertised via a <link rel="alternate"> on the
    // entity page head, not a site-wide feed — a quiet per-entity affordance (web: tertiary).
    apiFormat: "application/rss+xml",
    exposedContent: [
      "one artist's newest releases over a 30-day window, as RSS (release-dated, that artist only)",
    ],
    kind: "feed",
    name: "feed.fresh.artist.rss",
    operatorNotes:
      "Slug-parameterized (/artist/:slug/fresh.xml), so there is no fixed URL to health-probe — no probeConfig, like web.artist. An unknown slug 404s; a known artist with nothing in the window serves a valid empty feed. Source: apps/web/src/routes/artist.$slug.fresh[.]xml.ts + src/lib/server/fresh-entity.ts.",
    route: "/artist/:slug/fresh.xml",
    url: `${SITE}/artist/:slug/fresh.xml`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "application/rss+xml",
    exposedContent: [
      "one label's newest releases over a 30-day window, as RSS (release-dated, that label only)",
    ],
    kind: "feed",
    name: "feed.fresh.label.rss",
    operatorNotes:
      "Slug-parameterized (/label/:slug/fresh.xml), so there is no fixed URL to health-probe — no probeConfig, like web.artist. An unknown slug 404s; a known label with nothing in the window serves a valid empty feed. Source: apps/web/src/routes/label.$slug.fresh[.]xml.ts + src/lib/server/fresh-entity.ts.",
    route: "/label/:slug/fresh.xml",
    url: `${SITE}/label/:slug/fresh.xml`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "application/rss+xml",
    exposedContent: ["the mixtapes as a podcast feed (episode audio on found.fluncle.com)"],
    kind: "feed",
    name: "feed.podcast",
    route: "/podcast.xml",
    url: `${SITE}/podcast.xml`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "text/calendar",
    exposedContent: ["planned events as an iCalendar feed (Twitch-linked VEVENTs)"],
    kind: "feed",
    name: "feed.calendar",
    route: "/calendar.ics",
    url: `${SITE}/calendar.ics`,
    weights: { web: "tertiary" },
  },

  // ── Discovery (machine-/crawler-facing maps) ──────────────────────────────
  {
    apiFormat: "application/xml",
    exposedContent: ["the XML sitemap index of every public page"],
    kind: "discovery",
    name: "discovery.sitemap",
    operatorNotes:
      "A sitemap INDEX, not a flat urlset: the URLs live in children at /sitemap/<kind>-<n>.xml, ONE CHILD PER ENTITY TYPE (pages/findings/artists/labels/albums/galaxies/logbook), each auto-paged under Google's 50,000-URL ceiling so a breach cannot happen rather than merely not having happened yet. robots.txt still names this one URL — a crawler discovers the children from here. Splitting per entity type is also the diagnostic: Search Console reports coverage PER sitemap, so each entity type gets its own submitted/indexed count.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/sitemap.xml",
    url: `${SITE}/sitemap.xml`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/xml",
    exposedContent: [
      "one child sitemap, per entity type: the pages / findings / artists / labels / albums / galaxies / logbook URLs, auto-paged",
    ],
    kind: "discovery",
    name: "discovery.sitemap-shard",
    // The probe targets a child that always exists: `pages-1` is the static hubs, which are
    // never empty. A kind with no rows is simply not listed in the index (and 404s here),
    // which would read as a false "down".
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/sitemap/$shard",
    url: `${SITE}/sitemap/pages-1.xml`,
    weights: {},
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
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "text/markdown",
    discoveryUrl: `${SITE}/.well-known/api-catalog`,
    exposedContent: ["the plain-language map of the Galaxy for LLMs"],
    kind: "discovery",
    name: "discovery.llms",
    route: "/llms.txt",
    url: `${SITE}/llms.txt`,
    weights: { web: "primary" },
  },
  {
    apiFormat: "text/markdown",
    exposedContent: ["the entire archive in one ingestible markdown document, every finding"],
    kind: "discovery",
    name: "discovery.llms-full",
    route: "/llms-full.txt",
    url: `${SITE}/llms-full.txt`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/openapi+json",
    exposedContent: ["the public API as an OpenAPI 3.1 document (admin paths excluded)"],
    kind: "discovery",
    name: "discovery.openapi",
    route: "/api/v1/openapi.json",
    url: `${SITE}/api/v1/openapi.json`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/json",
    exposedContent: ["the SEP-2127 discovery card for the MCP endpoint"],
    kind: "discovery",
    name: "discovery.mcp-server-card",
    route: "/.well-known/mcp/server-card.json",
    url: `${SITE}/.well-known/mcp/server-card.json`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "application/linkset+json",
    exposedContent: ["the RFC 9727 linkset pointing at the machine-readable surfaces"],
    kind: "discovery",
    name: "discovery.api-catalog",
    route: "/.well-known/api-catalog",
    url: `${SITE}/.well-known/api-catalog`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "application/json",
    exposedContent: ["the fluncle-api agent skill index (with the SKILL.md digest)"],
    kind: "discovery",
    name: "discovery.agent-skills",
    route: "/.well-known/agent-skills/index.json",
    url: `${SITE}/.well-known/agent-skills/index.json`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "application/json+oembed",
    exposedContent: [
      "the oEmbed 1.0 provider — a pasted /log link unfurls as a rich finding card, and a /artist, /label, /album, or /mixtapes link as a link card (Discord/Notion/WordPress/Ghost/…)",
      "html iframes the self-contained /embed/<logId> card; thumbnail is the finding's OG image",
    ],
    kind: "discovery",
    name: "discovery.oembed",
    operatorNotes:
      'GET /oembed?url=<a fluncle.com /log|/mixtapes|/artist|/label|/album URL>&format=json — the provider resolves each. The auto-discovery `<link rel="alternate" type="application/json+oembed">` rides the /log, mixtape, and /artist heads today; a consumer unfurls a /label or /album link by hitting the provider directly (those page heads can advertise it later). XML → 501 (JSON only). No probeConfig — a bare GET without a valid `url` param is a 404, so there is no fixed URL to health-probe (like web.artist). The `rich` html frames /embed/<logId> (apps/web/src/routes/embed.$logId.ts), a standalone dark card served with a permissive `frame-ancestors *` CSP scoped to that route. Source: apps/web/src/routes/oembed.ts + src/lib/oembed.ts.',
    route: "/oembed",
    url: `${SITE}/oembed`,
    weights: { web: "tertiary" },
  },

  // ── MCP server ────────────────────────────────────────────────────────────
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/.well-known/mcp/server-card.json`,
    exposedContent: [
      "the archive as MCP tools (Streamable HTTP, no auth): list_tracks, list_fresh, get_track, get_random_track, get_status, search_archive, get_artist, get_label, build_set, get_similar_artists, list_album_catalogue, list_artist_catalogue, list_label_catalogue, search_tracks, submit_track, subscribe_newsletter",
      "the archive as MCP resources: each finding/mixtape at fluncle://finding/<logId> or fluncle://mixtape/<logId> (its public record)",
      "Fluncle-voiced MCP prompts: recommend_finding, walk_recent_night, decode_coordinate",
    ],
    kind: "mcp",
    name: "mcp.server",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/mcp",
    url: `${SITE}/mcp`,
    weights: { web: "primary" },
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
    weights: { status: "tertiary", web: "tertiary" },
  },

  // ── SSH (the rave terminal) ────────────────────────────────────────────────
  {
    command: "ssh rave.fluncle.com",
    exposedContent: [
      "the rave terminal TUI: Latest bangers, Fresh releases, Artist archive, Sonic galaxies, Mixtape archive, Random banger, Submit, Subscribe, Install CLI, System status, About",
      "deep-register one-shots: `ssh rave.fluncle.com latest|fresh|random`",
    ],
    kind: "ssh",
    name: "ssh.rave",
    operatorNotes: "apps/ssh (Go Wish/Bubble Tea). Probed on /status as service `ssh`.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "rave.fluncle.com",
    weights: { ssh: "primary", status: "secondary", web: "primary" },
  },

  // ── CLI (the `fluncle` thin client) ────────────────────────────────────────
  {
    command: "fluncle recent",
    exposedContent: ["the latest bangers, newest first (alias `list`)"],
    kind: "cli",
    name: "cli.recent",
    weights: { cli: "primary", web: "tertiary" },
  },
  {
    command: "fluncle fresh",
    // Release-date axis, distinct from `recent`'s found-date: what just CAME OUT, not what he found.
    exposedContent: ["the newest drum & bass releases, newest out first"],
    kind: "cli",
    name: "cli.fresh",
    weights: { cli: "secondary", web: "tertiary" },
  },
  {
    command: "fluncle mixtapes",
    exposedContent: ["Fluncle's checkpoint sets"],
    kind: "cli",
    name: "cli.mixtapes",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle artists",
    exposedContent: ["every artist with at least one published finding (bare `slug` looks one up)"],
    kind: "cli",
    name: "cli.artists",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle open",
    exposedContent: ["pick a track, open it in Spotify"],
    kind: "cli",
    name: "cli.open",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle random",
    exposedContent: ["the archive throws one back"],
    kind: "cli",
    name: "cli.random",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle subscribe",
    exposedContent: ["subscribe to the Friday newsletter"],
    kind: "cli",
    name: "cli.subscribe",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle submit",
    exposedContent: ["send a track for review"],
    kind: "cli",
    name: "cli.submit",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle tracks get",
    exposedContent: ["look up one finding by id or Log ID (group alias `track`)"],
    kind: "cli",
    name: "cli.tracks-get",
    weights: { cli: "tertiary" },
  },
  {
    command: "fluncle tracks similar",
    exposedContent: [
      "the findings that sound nearest to one (the sonic neighbourhood, off the MuQ audio embedding), each with its note",
    ],
    kind: "cli",
    name: "cli.tracks-similar",
    weights: { cli: "tertiary" },
  },
  {
    command: "fluncle about",
    exposedContent: ["Fluncle, and where to find him"],
    kind: "cli",
    name: "cli.about",
    weights: { cli: "tertiary" },
  },
  {
    command: "fluncle version",
    exposedContent: ["print or check the version (--check hits the latest GitHub release)"],
    kind: "cli",
    name: "cli.version",
    weights: { cli: "tertiary" },
  },
  {
    command: "fluncle admin",
    exposedContent: [
      "the operator/agent command group (hidden): tracks publish|update|enrich|video|draft|social|preview|observe|context|note, recordings create|promote, mixtapes update|distribute|resync, newsletter draft|update|send|list, backfills, auth",
    ],
    kind: "cli",
    name: "cli.admin",
    operatorNotes: "Authenticated admin/agent tier. The enrichment crons drive a subset of these.",
    weights: { cli: "hidden" },
  },

  // ── Browser extensions (vendor-store surfaces) ─────────────────────────────
  {
    exposedContent: [
      "Fluncle Lens — the browser extension that finds fluncle:// coordinates on any page and links each to its /log/<coord> finding (with a hover card from the public API)",
    ],
    kind: "extension",
    name: "extension.lens",
    // LIVE on the Chrome Web Store (published 2026-06-29, extension id
    // efkkceaofendabikblfjhoepgejfpakk). A `secondary` web surface: advertised on
    // the homepage dev-row and the /about page, not a homepage headline. No
    // probeConfig — a vendor store listing is not one of our own health-probeable
    // endpoints (the on-box healthcheck walks web/r2/dns/ssh + the crons, never an
    // external GET), and Google's store would bot-block / redirect a bare GET and
    // read back as a false "down". Source: apps/extension.
    operatorNotes:
      "Fluncle Lens (apps/extension), MV3, LIVE on the Chrome Web Store (published 2026-06-29). Store listing reachability is Google's, not ours, so it is not on the /status board.",
    url: "https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk",
    weights: { web: "secondary" },
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
    statusDescription: "BPM, key, and the spectral fingerprint",
    title: "Audio enrichment",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin tracks embed --queue",
    exposedContent: [
      "MuQ-large audio embedding (1024-d) for sonic similarity + clusters (--no-agent, on-box torch)",
    ],
    kind: "cron",
    name: "cron.embed",
    operatorNotes:
      "every 5m. On-box MuQ (torch, ~16s/track), zero LLM tokens. Writes the vector via the agent-tier update_track. Source: docs/agents/hermes/scripts/embed-sweep.* + embed-track.py. See docs/track-lifecycle.md.",
    probeConfig: { cadenceMs: 5 * MINUTE_MS, cronName: "fluncle-embed", kind: "cron" },
    statusDescription: "MuQ vectors for sonic similarity",
    title: "Audio embeddings",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin galaxies map",
    exposedContent: [
      "nightly assignment of each finding to its nearest sonic galaxy (k-means over the MuQ space)",
    ],
    kind: "cron",
    name: "cron.cluster",
    operatorNotes:
      "nightly (02:20 Amsterdam), run by a rave-02 HOST systemd timer (docs/agents/hermes/cluster-timer/). Assignment-ONLY + idempotent (a no-op on an unchanged corpus): assign each finding to its nearest stored centroid, recompute centroids as members' means, retire an emptied galaxy, consume an operator split_requested_at (a k=2 fit). Zero LLM tokens; sub-second CPU. A full k=9 fit is an OPERATOR act (--cold-start / --remint), never scheduled. Source: docs/agents/hermes/scripts/cluster-sweep.* + cluster.py. See docs/agents/cluster-engine.md.",
    probeConfig: { cadenceMs: 24 * 60 * MINUTE_MS, cronName: "fluncle-cluster", kind: "cron" },
    statusDescription: "groups the archive into sonic galaxies",
    title: "Sonic galaxies",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin catalogue crawl",
    exposedContent: [
      "walk the MusicBrainz release graph outward from the operator's enabled seed labels → uncertified catalogue rows",
    ],
    kind: "cron",
    name: "cron.crawl",
    operatorNotes:
      "every 10m, run by a rave-02 HOST systemd timer (docs/agents/hermes/crawl-timer/). METADATA ONLY — it writes a `tracks` row with no `findings` row, so it certifies nothing (no Log ID, no note, no video, no public surface) and it captures no audio. Worker-paced (the box holds no MusicBrainz budget): one bounded pass per tick over the durable `crawl_frontier`, so a crawl is a marathon the SCHEDULE finishes and a reboot mid-label costs one node, not one crawl. The boundary gate is the operator's seed-label allowlist + graph distance (hop 0-2), never genre inference; a label the walk discovers enters `undecided` and is NOT crawled until he rules on it. Zero LLM tokens. Source: docs/agents/hermes/scripts/crawl-sweep.*. See docs/catalogue-crawler.md.",
    probeConfig: { cadenceMs: 10 * MINUTE_MS, cronName: "fluncle-crawl", kind: "cron" },
    statusDescription: "charts new tracks from the wider label graph",
    title: "Track crawler",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "tap day-one fresh releases for the operator's enabled seed labels → uncertified catalogue rows",
    ],
    kind: "cron",
    name: "cron.label-releases",
    operatorNotes:
      "every 24h, run by a rave-02 HOST systemd timer (docs/agents/hermes/label-releases-timer/). The FRESHNESS TAP (D8): MusicBrainz WALKS the graph (cron.crawl) but lags a release ~2 weeks; Spotify has it day one, so this mints METADATA-ONLY catalogue rows (a `tracks` row with no `findings` row) for each ENABLED seed label's fresh releases with their real dates — closing the /fresh lag cliff. The WORKER does all of it (`backfill_label_releases`, agent tier): it searches the official Spotify API (`label:\"<name>\" tag:new`), reads each hit as a SINGLE `GET /albums/{id}` then `GET /tracks/{id}` (the batch endpoints are 403 at our tier), and mints. The box sweep is a thin HTTP TRIGGER that POSTs bounded passes with the agent token — no vendor token, no CLI dependency (a pinned box CLI missing a flag broke an earlier run). The gate, both required: artist-grounding (an album's Spotify artist already in `artists.spotify_artist_id` — the PRIMARY anchor that stops cross-genre homonym junk) AND an EXACT fold-match of the seed name in the ℗/© copyright; an album with no release_date is dropped outright (/fresh could never show it). BUDGET: the tap shares the official app's per-app window with the user-facing paths, so it paces itself against the shared call meter and stops at a FRACTION of the window (its own ceiling) — user write paths get the window, the tap takes only slack. Hitting that ceiling ends the pass cleanly and the durable per-label cadence stamps resume it next tick. It certifies nothing, publishes nothing, never widens the graph (no new labels, no artist hops). Deduped against the MB crawl from both directions (Spotify id/uri/ISRC + same-album title fold). No vendor spend and zero LLM tokens. Source: docs/agents/hermes/scripts/label-releases-sweep.*. See docs/catalogue-crawler.md.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-label-releases",
      kind: "cron",
    },
    statusDescription: "taps day-one releases from the enabled labels",
    title: "Freshness tap",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin catalogue rank",
    exposedContent: [
      "score each stale catalogue track against every embedded finding → its nearest finding + capture priority",
    ],
    kind: "cron",
    name: "cron.rank",
    operatorNotes:
      "every 30m, run by a rave-02 HOST systemd timer (docs/agents/hermes/rank-timer/). THE EAR's schedule, and it lands with the crawler on purpose: a timer ranking an empty table would be a /status row that means nothing, and the crawler is what creates rows. All the vector arithmetic runs in SQL inside the Worker; the sweep DRAINS (it loops while `remaining > 0` up to a tick budget), so a crawl that just landed 700 rows is ranked by the next tick. Self-healing: staleness is a fingerprint of the finding corpus, so logging or embedding a finding re-ranks the catalogue with no invalidation call. Writes DERIVED columns on catalogue rows only — it cannot certify. Zero LLM tokens. Source: docs/agents/hermes/scripts/rank-sweep.*. See docs/the-ear.md.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-rank", kind: "cron" },
    statusDescription: "ranks unvisited tracks by nearness to the archive",
    title: "Track ranking",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "find each un-anchored catalogue row's Spotify track via Apify → its spotify_uri/spotify_url anchor",
    ],
    kind: "cron",
    name: "cron.anchor",
    operatorNotes:
      "hourly, run by a rave-02 HOST systemd timer (docs/agents/hermes/anchor-timer/). Fills the catalogue Spotify anchor OFF the official (dev-mode) Spotify app, which starved under 429s at catalogue scale and must stay for user-facing paths: the box runs an Apify Spotify-scraper actor to find candidates for each un-anchored catalogue row and POSTs them to the agent-tier `anchor_track` op, where the WORKER re-runs verification (exact ISRC, else the folded artist+title+±2s search triple — the box's verdict is never trusted) and writes the anchor on a hit. Every attempt stamps a 14-day re-ask backoff so a miss is not re-billed. The ONE new secret is APIFY_API_TOKEN; each row is a billed Apify search (~$0.015), so the default 15 rows/hour ≈ $5-6/day while the backlog drains — pause by stopping the timer, burn attended with `--limit N`. Calls the oRPC HTTP endpoints directly (no new CLI command the pinned box CLI would lack). Source: docs/agents/hermes/scripts/anchor-sweep.*. See docs/catalogue-crawler.md § the anchor.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-anchor", kind: "cron" },
    statusDescription: "finds each catalogue track's Spotify link",
    title: "Spotify anchors",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin frontier refresh",
    exposedContent: [
      "re-mirror every crew member's Fluncle's Frontier playlist from their current recommendations",
    ],
    kind: "cron",
    name: "cron.frontier-refresh",
    operatorNotes:
      "every ~15 min, run by a rave-02 HOST systemd timer (docs/agents/hermes/frontier-refresh-timer/). E2, the public recommendation machine: every verified user can mint ONE public 'Fluncle's Frontier' playlist on Fluncle's OWN Spotify account (no per-user OAuth), holding THEIR recommendations (the E1 blend); this cron keeps each one current. It is a PACED, RESUMABLE DRAIN, not a weekly burst: each tick fires one `fluncle admin frontier refresh` that processes only a small BATCH of DUE users inside the Worker (pending mints first, then users whose per-user cursor is older than ~6 days), so the whole crew refreshes ~weekly SPREAD across the day instead of one 07:00 pass that collided with Spotify's shared per-app budget and 429'd live user paths. It consults the shared Spotify budget and stops cleanly when the window is spent (`budgetPaused`), respects the DEFAULT-DENY `frontier.minting` kill switch (a closed switch touches nothing on Spotify), skips playlists whose recommendation set is unchanged (a per-row URI-hash mirror guard), and creates no new public authority — every playlist it touches already exists, minted by its own owner. `refresh_frontier_playlists` is AGENT tier, so the box's existing agent-scoped token drives it: NO new secret. Zero LLM tokens. Source: docs/agents/hermes/scripts/frontier-refresh-sweep.*. See docs/the-ear.md § Fluncle's Frontier.",
    probeConfig: {
      cadenceMs: 15 * MINUTE_MS,
      cronName: "fluncle-frontier-refresh",
      kind: "cron",
    },
    statusDescription: "refreshes the crew's Frontier playlists, paced",
    title: "Frontier refresh",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin backfills label-images",
    exposedContent: [
      "resolve each pending label's own logo (Discogs → Wikidata → cover floor) → its own R2 image",
    ],
    kind: "cron",
    name: "cron.label-images",
    operatorNotes:
      "every 60m, run by a rave-02 HOST systemd timer (docs/agents/hermes/label-images-timer/). The DURABLE other half of the label entity: the crawler MINTS new labels every few minutes (each `image_state='pending'`) and the one-shot operator backfill only seeded the labels that already existed, so this cron is what gives every freshly-minted label its OWN logo instead of a borrowed album cover. METADATA ONLY — a label logo is internal, reversible, nominative-use trademark (the album-art posture); it certifies nothing and publishes nothing (agent tier, the `backfill_discogs` precedent). Worker-paced (the box holds no Discogs key / MusicBrainz budget): one bounded batch per tick walks each label's MB identity → its curated Discogs/Wikidata url-rels → downloads the logo once into R2, up the ladder Discogs → Wikidata → none (the freshest-cover floor). The `labels` row carries the durable reliability state (image_state/image_attempted_at/image_failures), so a resolved/none label is terminal and a vendor throttle just circuit-breaks and resumes next tick. Zero LLM tokens. Source: docs/agents/hermes/scripts/label-images-sweep.*. See docs/label-entity.md.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-label-images", kind: "cron" },
    statusDescription: "resolves each label's own mark",
    title: "Label logos",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin backfills recording-mbids",
    exposedContent: [
      "fill each track's canonical MusicBrainz recording MBID (crawler PK strip + ISRC resolve)",
    ],
    kind: "cron",
    name: "cron.recording-mbids",
    operatorNotes:
      "every 60m, run by a rave-02 HOST systemd timer (docs/agents/hermes/recording-mbids-timer/). The MusicBrainz identity layer: gives every track its canonical MusicBrainz recording MBID — the one identifier that reconciles a track to the wider open music graph (MusicBrainz, Wikidata) and the anchor the `/log` MusicRecording emits as a `sameAs` + a KG `identifier`. Two fill paths: a FREE SQL strip of crawler-born rows' PK (`mb_<recording-mbid>` → the `mb_recording_id` column, no vendor call), then an ISRC→recording resolve of the findings/Spotify-born tail through the shared MusicBrainz client (`/isrc/<isrc>`). New crawler rows already carry the MBID at mint time, so this cron catches history up + drains the ISRC tail. METADATA IDENTITY ONLY — it certifies nothing and publishes nothing (agent tier, the `backfill_label_images` precedent). Worker-paced (the box holds no MusicBrainz budget): one bounded batch per tick, 1 req/s, circuit-broken on a throttle. The `tracks` row carries the durable reliability state (`mb_recording_id` + the `mb_recording_id_attempted_at` stamp, a miss stamped so it is not re-queried forever). Zero LLM tokens. Source: docs/agents/hermes/scripts/recording-mbids-sweep.*. See docs/catalogue-crawler.md.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-recording-mbids", kind: "cron" },
    statusDescription: "fills each track's MusicBrainz recording id",
    title: "Recording MBIDs",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin backfills artist-edges",
    exposedContent: [
      "fold each edge-less track's artists_json names onto existing artist identities → track_artists edges",
    ],
    kind: "cron",
    name: "cron.artist-edges",
    operatorNotes:
      "every 60m, run by a rave-02 HOST systemd timer (docs/agents/hermes/artist-edges-timer/). The track_artists GRAPH BACKFILL (RFC artist-primary-capture, slice 0): the graph is crawl-era-only (born 2026-07-15) — only ~12.3k of ~37.5k tracks carry edges — so this folds each edge-less track's `artists_json` NAMES onto EXISTING `artists` identities and writes the `track_artists` edges, making the graph as full as honest matching allows (slice 1's identity-keyed capture authorization reads it). The matcher is IDENTITY-HONEST: each name matches by exact case-insensitive fold, then via `artist_aliases` (kind='name', status auto|confirmed — the search resolver's alias semantics); a fold two distinct identities share is ambiguous and matches nothing (fail-closed). It MINTS NOTHING — a bare name is not enough identity to create an entity — and reports the UNMATCHED RESIDUAL (credited names with no identity), which decides whether a later paced MusicBrainz credit-sweep is worth running. METADATA / GRAPH IDENTITY ONLY — it certifies nothing and publishes nothing (agent tier, the `backfill_recording_mbids` precedent). Worker-paced with NO vendor call (pure DB set-based matching, so no rate limit / circuit breaker): one bounded batch per tick folds the whole ~1.8k-row artist+alias corpus into one in-memory map and matches each track batch against it. The `tracks` row carries the durable reliability state (the `artist_edges_backfilled_at` stamp on EVERY visited row — matched, partial, or zero — so the worklist drains and a re-run is a no-op). New tracks are minted WITH edges (publish path + crawler link), so this catches history up and drains in a handful of ticks. Zero LLM tokens. Source: docs/agents/hermes/scripts/artist-edges-sweep.*. See docs/artist-relationship.md.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-artist-edges", kind: "cron" },
    statusDescription: "folds artists_json names onto artist identities",
    title: "Artist edges",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin backfills label-lineage",
    exposedContent: [
      "resolve each label's founding date + place + parent imprint from MusicBrainz → the labels row",
    ],
    kind: "cron",
    name: "cron.label-lineage",
    operatorNotes:
      "every 60m, run by a rave-02 HOST systemd timer (docs/agents/hermes/label-lineage-timer/). The label entity's LINEAGE half (RFC label-lineage-remixer, U1): gives each label its founding facts + its place in the imprint hierarchy from MusicBrainz — `life-span.begin` → `founding_date`, `area.name` → `founded_location`, and the `backward` `label ownership` / `imprint` label-rels → `parent_label_id` (matched to an EXISTING label by MBID; NEVER minted — an unmatched parent is only counted). A dedicated sweep, not a rider on the label-image sweep, because that one is terminal per label and a logo-resolved label would never get its lineage: this carries its OWN `lineage_state` machine so it reaches every label once. METADATA ONLY — it certifies nothing, mints nothing, publishes nothing (agent tier, the `backfill_label_images` precedent). Worker-paced (the box holds no MusicBrainz budget): one bounded batch per tick, 1 req/s, circuit-broken on a throttle, reusing the shared MB client + exact-fold identity search. The `labels` row carries the durable reliability state (lineage_state/lineage_attempted_at/lineage_failures), so a resolved/none label is terminal. Emitted as the `/label/<slug>` Organization's `foundingDate` / `location` / `parentOrganization` / `subOrganization`. Zero LLM tokens. Source: docs/agents/hermes/scripts/label-lineage-sweep.*. See docs/label-entity.md.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-label-lineage", kind: "cron" },
    statusDescription: "resolves each label's founding and imprint",
    title: "Label lineage",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin backfills cover-masters",
    exposedContent: [
      "resolve each pending album/artist its OWN ≤1200² cover master (best source wins) → its own R2 image",
    ],
    kind: "cron",
    name: "cron.cover-masters",
    operatorNotes:
      "every 60m, run by a rave-02 HOST systemd timer (docs/agents/hermes/cover-masters-timer/). The DURABLE other half of the album/artist cover (RFC musickit-second-authority U3b): the publish path + catalogue crawl MINT albums/artists (each `image_state='pending'`) and this cron gives each its OWN ≤1200²-capped cover derivative in R2 (found.fluncle.com, `albums/<slug>.<ext>` / `artists/<slug>.<ext>`) instead of hotlinking a third party — the label-logo posture, two entities over. IMAGE ONLY — a downscaled display derivative, reversible, the REF-05-conscious 1200 line (docs/album-artwork.md); it certifies nothing and publishes nothing (agent tier, the `backfill_label_images` precedent). Worker-paced: one bounded batch of albums (Apple template → Cover Art Archive → Spotify floor), then one of artists (Spotify floor), per tick; every rung requests a ≤1200 rendition and a byte read enforces the cap before the R2 put, so no un-downscaled original is ever stored. The `albums`/`artists` row carries the durable reliability state (image_state/image_attempted_at/image_failures), so a resolved/none entity is terminal. Served via Cloudflare Images `/cdn-cgi/image/…` (decision B). Zero LLM tokens. Source: docs/agents/hermes/scripts/cover-masters-sweep.*. See docs/album-artwork.md.",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-cover-masters", kind: "cron" },
    statusDescription: "owns each album and artist its cover master",
    title: "Cover masters",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin tracks capture-audio --queue",
    exposedContent: [
      "capture each finding's full song once → private R2 (yt-dlp via a residential proxy)",
    ],
    kind: "cron",
    name: "cron.capture",
    operatorNotes:
      "every 5m, run by a rave-02 HOST systemd timer (docs/agents/hermes/capture-timer/) — NOT a gateway cron: a proxied yt-dlp fetch has an unbounded tail that would starve the 5-min enrich/context/note sweeps on the shared serial runner. A NON-BLOCKING side-channel (never gates enrich/embed). Runs yt-dlp through a residential proxy on a per-track sticky session, duration-guards the match, stores the full song in the PRIVATE fluncle-source-audio bucket (S3-direct), and writes back via the agent-tier update_track (with per-finding backoff). yt-dlp + ffprobe are a box deploy prereq. Newest-first so a fresh add jumps the backfill. Source: docs/agents/hermes/scripts/capture-sweep.*. See docs/track-lifecycle.md.",
    probeConfig: { cadenceMs: 5 * MINUTE_MS, cronName: "fluncle-capture", kind: "cron" },
    statusDescription: "captures each finding's full song once",
    title: "Full-song capture",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin catalogue verify --queue",
    exposedContent: [
      "fingerprint-check each captured song against its official preview → the wrong-audio verdict",
    ],
    kind: "cron",
    name: "cron.verify-captures",
    operatorNotes:
      "every 30m, run by a rave-02 HOST systemd timer (docs/agents/hermes/verify-captures-timer/). The HISTORIC half of the capture verification gate (docs/the-ear.md § Wrong audio): the capture sweep verifies every NEW download at ingest, and this sweep walks every capture that landed before the gate existed and gives each the same Chromaprint check against the track's ISRC-resolved official preview. The box only MEASURES (fpcalc + the sliding-window match) and reports a plain verdict; the Worker ROUTES it — match/no-preview stamp `capture_verification`, a CATALOGUE mismatch quarantines for re-capture, a FINDING mismatch only raises the `capture-suspect` /admin attention item (a machine never rewinds a public finding; the operator rules with flag_wrong_audio). Resumable by construction (a stamped row leaves the worklist); degrades honestly without fpcalc (pre-rebake: `fpcalc_missing`, nothing stamped). Zero LLM tokens. Source: docs/agents/hermes/scripts/verify-captures.* + fingerprint-match.ts. See docs/the-ear.md.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-verify-captures", kind: "cron" },
    statusDescription: "checks each captured song against its official preview",
    title: "Capture verification",
    weights: { status: "hidden" },
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
    statusDescription: "distills the facts behind each finding",
    title: "Context notes",
    weights: { status: "hidden" },
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
    statusDescription: "writes each finding's editorial note",
    title: "Editorial notes",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin artists describe --queue",
    exposedContent: [
      "auto-author the /artist/<slug> voiced bio, fill-empty-only (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.artist-bio",
    operatorNotes:
      "every 30m. Hybrid --no-agent; one claude -p authors the paragraph, its grounding assembled WORKER-side (Firecrawl facts + the artist's finding titles) via the draft-bio op. Never clobbers an operator bio. Live. Source: docs/agents/hermes/scripts/{entity-bio-sweep.ts,artist-bio-sweep.sh}.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-artist-bio", kind: "cron" },
    statusDescription: "writes each artist's voiced bio",
    title: "Artist bios",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin labels describe --queue",
    exposedContent: [
      "auto-author the /label/<slug> voiced bio, fill-empty-only (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.label-bio",
    operatorNotes:
      "every 30m. Hybrid --no-agent; one claude -p authors the paragraph, its grounding assembled WORKER-side (Firecrawl facts + the label's finding titles) via the draft-bio op. Never clobbers an operator bio. Live. Source: docs/agents/hermes/scripts/{entity-bio-sweep.ts,label-bio-sweep.sh}.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-label-bio", kind: "cron" },
    statusDescription: "writes each label's voiced bio",
    title: "Label bios",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin albums describe --queue",
    exposedContent: [
      "auto-author the /album/<slug> voiced bio, fill-empty-only (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.album-bio",
    operatorNotes:
      "every 30m. Hybrid --no-agent; one claude -p authors the paragraph, its grounding assembled WORKER-side (Firecrawl facts + the album's finding titles) via the draft-bio op. Never clobbers an operator bio. Live. Source: docs/agents/hermes/scripts/{entity-bio-sweep.ts,album-bio-sweep.sh}.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-album-bio", kind: "cron" },
    statusDescription: "writes each album's voiced bio",
    title: "Album bios",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin submissions triage",
    exposedContent: [
      "pre-chew a pending crew submission → an advisory queue verdict, fill-first (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.triage",
    operatorNotes:
      "every 15m. Hybrid --no-agent; a deterministic archive dedupe + DnB-plausibility heuristic feeds one claude -p phrasing, length-gated. Writes the verdict onto a PENDING submission so it lands in the /admin attention queue already assessed; approve/reject stays operator tier. Source: docs/agents/hermes/scripts/triage-sweep.{sh,ts}.",
    probeConfig: { cadenceMs: 15 * MINUTE_MS, cronName: "fluncle-triage", kind: "cron" },
    statusDescription: "pre-chews each crew submission's verdict",
    title: "Submission triage",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin logbook gaps",
    exposedContent: [
      "author the previous day's Logbook travelogue entry, fill-empty-only (hybrid: one claude -p call)",
    ],
    kind: "cron",
    name: "cron.logbook",
    operatorNotes:
      "00:40 Amsterdam daily. Hybrid --no-agent; one claude -p writes the day up. Never clobbers an operator entry; the self-healing gap window backfills history oldest-first. Source: docs/agents/hermes/scripts/logbook-sweep.{sh,ts}.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-logbook",
      kind: "cron",
      schedule: { time: "00:40", tz: "Europe/Amsterdam" },
    },
    statusDescription: "writes each sector-day up in the Logbook",
    title: "Logbook author",
    weights: { status: "hidden" },
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
    statusDescription: "Fluncle's spoken field observations",
    title: "Audio observations",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin backfills discogs && fluncle admin backfills lastfm",
    exposedContent: ["Discogs id + Last.fm love catalogue repair (--no-agent, Worker HTTP)"],
    kind: "cron",
    name: "cron.backfill",
    operatorNotes: "every 30m. Pure HTTP driving, zero LLM tokens. Agent tier.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-backfill", kind: "cron" },
    statusDescription: "repairs Discogs ids and Last.fm loves",
    title: "Metadata backfill",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "resolve each artist's social identity: MB url-rel walk + Firecrawl gap-fill (TikTok + YouTube)",
    ],
    kind: "cron",
    name: "cron.artist-sweep",
    operatorNotes:
      "every 60m. --no-agent trigger; the Worker does the MB walk + Firecrawl /v2/extract + YouTube channel resolution. Zero on-box tokens. MB rows land as status=auto (trusted); Firecrawl rows as status=candidate (operator-confirm before public). Source: docs/agents/hermes/scripts/artist-sweep.*",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-artist-sweep", kind: "cron" },
    statusDescription: "resolves each artist's socials and identity links",
    title: "Artist resolution",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin tracks social --capture",
    exposedContent: [
      "capture the YouTube/TikTok post URLs Postiz withholds on create → write back (--no-agent, Worker HTTP)",
    ],
    kind: "cron",
    name: "cron.social-capture",
    operatorNotes:
      "every 10m. Pure HTTP trigger, zero LLM tokens. Agent tier (fills the public URL only — publishes nothing). The box's baked CLI predates the `--capture` verb, so the cron curls POST /api/admin/social/posts/capture directly; the Worker polls Postiz and writes back. Source: docs/agents/hermes/scripts/social-capture-sweep.sh. Probed on /status as cron.social-capture.",
    probeConfig: { cadenceMs: 10 * MINUTE_MS, cronName: "fluncle-social-capture", kind: "cron" },
    statusDescription: "the live YouTube and TikTok URLs for each posted video",
    title: "Social links",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "cut each pending operator-framed 9:16 clip out of its set video → ship to R2 (--no-agent, ffmpeg)",
    ],
    kind: "cron",
    name: "cron.studio-clip",
    operatorNotes:
      "every 15m. Pure-trigger, zero LLM tokens: a deterministic ffmpeg cut driven by the fluncle CLI (`admin clips list` → `admin clips cut`), agent-scoped (list_clips + the agent-tier presign_clip_upload / finalize_clip_cut). Cuts the operator-framed 9:16 clips from the /admin/studio editor (keyed by Log ID) out of the set video → ships `<clipId>/footage.mp4` to R2 for the /admin/clips library + the clip drip-feed. The box runs the standalone bun BINARY (the npm thin client can't spawn ffmpeg). Source: docs/agents/hermes/scripts/clip-sweep.sh. Probed on /status as cron.studio-clip.",
    probeConfig: { cadenceMs: 15 * MINUTE_MS, cronName: "fluncle-studio-clip", kind: "cron" },
    statusDescription: "cuts set videos into 9:16 clips",
    title: "Studio clips",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin clips drip-pause",
    exposedContent: [
      "post the due, cut clips to Instagram on a jittered ~daily cadence via Postiz (--no-agent, Worker HTTP)",
    ],
    kind: "cron",
    name: "cron.clip-drip",
    operatorNotes:
      "every 20m. Pure HTTP trigger, zero LLM tokens. Admin tier (needs the Worker's Postiz key, which the box never sees — the box only triggers; the `finalize_clip_cut` / `record_health` precedent). The Worker checks the global kill switch FIRST (paused → no-op), then posts due clips bounded by a per-tick cap AND a rolling-24h IG cap. Every clip auto-enters the schedule at a jittered ~23-25h after the queue tail. The operator pauses/resumes with `fluncle admin clips drip-pause` / `drip-resume`. Source: docs/agents/hermes/scripts/clip-drip-sweep.sh. Probed on /status as cron.clip-drip.",
    probeConfig: { cadenceMs: 20 * MINUTE_MS, cronName: "fluncle-clip-drip", kind: "cron" },
    statusDescription: "drip-feeds set clips to Instagram",
    title: "Clip drip-feed",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin publish pause",
    exposedContent: [
      "advance one freshly-rendered finding into the publish push — YouTube Short + TikTok inbox draft (--no-agent, Worker HTTP)",
    ],
    kind: "cron",
    name: "cron.publish-advance",
    operatorNotes:
      "every 30m. Pure HTTP trigger, zero LLM tokens. The last autonomy gap: render finishes → this pushes, with no operator beat between. Admin tier (needs the Worker's Postiz key, which the box never sees — the box only triggers; the `drip_clips` / `capture_post_urls` precedent). SHIPS DARK: the Worker's kill switch is DEFAULT-DENY (only an explicit `false` in the `publish_advance_paused` setting runs it), so the timer ticks and posts nothing until `fluncle admin publish resume`. The Worker reads the switch FIRST, then advances at most ONE ready finding — both masters finalized, 15m settled, the whole bundle served on R2, the (track, platform) row CLAIMED atomically before any Postiz call, a rolling-24h cap of 6 pushes. A failed push is left `failed` for the operator and never auto-retried. Source: docs/agents/hermes/scripts/publish-advance-sweep.sh. Probed on /status as cron.publish-advance.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-publish-advance", kind: "cron" },
    statusDescription: "advances the publish queue on his own clock",
    title: "Publish advance",
    weights: { status: "hidden" },
  },
  {
    command: "fluncle admin tracks queue",
    exposedContent: [
      "wake the rave-03 render box → render + ship one finding's video → park (conductor)",
    ],
    kind: "cron",
    name: "cron.render",
    operatorNotes:
      "every 60m. A conductor: triggers a detached @fluncle-video render on a scale-to-zero box.ascii box (rave-03). Never posts to social (operator-tier 403). Probed on /status as service `cron.render` (its own last-run freshness); the box's reachability is the SEPARATE `render-box` probe (the conductor state file).",
    probeConfig: { cadenceMs: 60 * MINUTE_MS, cronName: "fluncle-render", kind: "cron" },
    statusDescription: "the conductor's last run",
    title: "Render cron",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "probe each service → Discord-ping on a status flip → POST the /status snapshot (--no-agent)",
    ],
    kind: "cron",
    name: "cron.healthcheck",
    operatorNotes:
      "every 10m, run by a rave-02 host systemd timer (docs/agents/hermes/healthcheck-timer/) — decoupled from the Hermes cron gateway so the prober isn't starved by the scheduler it monitors. Pure probing, zero LLM tokens. POSTs to the agent-tier record_health op that /status reads.",
    probeConfig: { cadenceMs: 10 * MINUTE_MS, cronName: "fluncle-healthcheck", kind: "cron" },
    statusDescription: "the prober behind this very page",
    title: "Healthcheck prober",
    weights: { status: "hidden" },
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
      schedule: { time: "15:00", tz: "Europe/Amsterdam", weekday: 5 },
    },
    statusDescription: "drafts the Friday edition",
    title: "Weekly newsletter",
    weights: { status: "secondary" },
  },
  {
    exposedContent: [
      "daily gzip dump of the prod database → a PRIVATE R2 bucket (owned off-site backup) + 30 daily / 12 monthly retention (--no-agent)",
    ],
    kind: "cron",
    name: "cron.backup",
    operatorNotes:
      "daily. An OWNED, off-Cloudflare backup: dumps prod Turso over the libSQL HTTP pipeline → gzip → a PRIVATE R2 bucket (never fluncle-videos, which is world-served at found.fluncle.com) + prune. Zero LLM tokens; talks to Turso + R2 directly (no fluncle CLI, no agent token). Turso's managed PITR is the belt; this is the braces. Restore is proven by apps/web/scripts/restore-drill.ts. Source: docs/agents/hermes/scripts/backup-sweep.*",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-backup",
      kind: "cron",
      schedule: { time: "03:00", tz: "Europe/Amsterdam" },
    },
    statusDescription: "a daily off-site snapshot of the archive",
    title: "Database backup",
    weights: { status: "secondary" },
  },
  {
    command: "fluncle admin reach collect",
    exposedContent: [
      "daily snapshot of Fluncle's numbers across every platform (followers / subscribers / plays / stars) → one append-only row per (platform, metric) behind the public /reach page (--no-agent)",
    ],
    kind: "cron",
    name: "cron.reach",
    operatorNotes:
      "04:00 Amsterdam daily. A bare trigger (the catalogue-rank shape): fires the AGENT-tier record_platform_stats op once — the Worker fetches every Tier-1 platform best-effort and upserts one idempotent row per (platform, metric) keyed ${platform}:${metric}:${yyyy-mm-dd} (a same-day re-run lands inserted:0). Zero LLM tokens; the box's agent token drives it and every platform credential lives Worker-side (no new secret). Source: docs/agents/hermes/scripts/reach-sweep.*",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-reach",
      kind: "cron",
      schedule: { time: "04:00", tz: "Europe/Amsterdam" },
    },
    statusDescription: "counts the crew and how far the probes reached",
    title: "Reach snapshot",
    weights: { status: "secondary" },
  },
  {
    command: "fluncle admin catalogue demand",
    exposedContent: [
      "nightly demand reorder — reads Simple Analytics pageviews for /artist + /label pages and reorders crawl/capture priority toward what real visitors looked at (--no-agent)",
    ],
    kind: "cron",
    name: "cron.demand",
    operatorNotes:
      "04:40 Amsterdam daily (just after the 04:00 reach snapshot — both daily analytics reads in one window). A bare trigger (the reach/rank shape): fires the AGENT-tier record_demand op once — the WORKER reads Simple Analytics for the /artist/<slug> + /label/<slug> pageviews over the trailing 30 days and REWRITES two derived reorder columns, tracks.demand_score (the capture queue's within-tier secondary sort) and crawl_frontier.demand_rank (the frontier pick's within-hop tiebreak). RANK-ORDER ONLY: it reorders within a tier and never overrides the capture_priority veto (a ruled-out label is never resurrected); the seed-allowlist crawl gate is untouched. Clear-then-set, so a same-window re-run is idempotent. Unprovisioned (no SIMPLE_ANALYTICS_API_KEY) it returns configured:false and is a clean no-op. Zero LLM tokens; the box's agent token drives it and the SA key lives Worker-side (no new box secret). Source: docs/agents/hermes/scripts/demand-sweep.*. See docs/catalogue-crawler.md § Demand.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-demand",
      kind: "cron",
      schedule: { time: "04:40", tz: "Europe/Amsterdam" },
    },
    statusDescription: "leans the catalogue toward what visitors looked at",
    title: "Demand reorder",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "daily catalogue-funnel snapshot — one row per UTC day of stage totals + queue depths + frontier counts behind /admin/funnel (--no-agent)",
    ],
    kind: "cron",
    name: "cron.funnel-snapshot",
    operatorNotes:
      "23:45 UTC daily (end of the UTC day the snapshot is keyed on). A bare trigger (the reach/anchor shape): fires the AGENT-tier record_catalogue_snapshot op once — the Worker computes every stage total + queue depth + frontier count through the SAME predicates the sweeps run (lib/server/funnel.ts) and UPSERTS one idempotent row per UTC day (a same-day re-run overwrites, never doubles a bar). Zero LLM tokens; the box's agent token drives it and calls the oRPC HTTP endpoint directly (no new CLI command the pinned box CLI would lack), so no new secret. Source: docs/agents/hermes/scripts/funnel-snapshot-sweep.*. See docs/rfcs/catalogue-funnel-rfc.md.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-funnel-snapshot",
      kind: "cron",
      schedule: { time: "23:45", tz: "UTC" },
    },
    statusDescription: "records the catalogue pipeline's daily numbers",
    title: "Funnel snapshot",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "daily per-post social-metrics snapshot — appends each published post's Postiz reach (views/likes/comments/…) into an append-only ledger, one row per post per day (--no-agent)",
    ],
    kind: "cron",
    name: "cron.social-metrics",
    operatorNotes:
      "22:15 UTC daily (clear of the 23:45 funnel snapshot). A bare trigger (the funnel-snapshot/reach shape): fires the AGENT-tier record_social_metrics op once — the Worker selects a deterministic ≤25-post budget (every post published in the last 14 days, then a rolling least-recently-snapshotted tail; the Postiz 30/hour cap), reads each one's Postiz per-post analytics, and APPENDS one social_metrics row per (post, source, UTC day) — append-only (velocity), idempotent per day. Also reads the Simple-Analytics social→site referrer arrivals for observability. Zero LLM tokens; the box's agent token drives it and the Postiz + SA keys live Worker-side (no new secret). Source: docs/agents/hermes/scripts/social-metrics-sweep.*.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-social-metrics",
      kind: "cron",
      schedule: { time: "22:15", tz: "UTC" },
    },
    statusDescription: "records how far each posted video reached",
    title: "Social metrics",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "nightly codebase audit — one domain/night on a 7-day rotation; opens a PR the reviewer merges (claude -p, subscription auth)",
    ],
    kind: "cron",
    name: "cron.audit",
    operatorNotes:
      "01:00 Amsterdam, a rave-02 host systemd timer (docs/agents/hermes/audit-timer/). A full agentic claude -p session: audits the day's domain, fixes what's safe, files the rest to docs/audit-backlog.md, opens a PR. Subscription auth (CLAUDE_CODE_OAUTH_TOKEN), zero OpenRouter tokens. Source: docs/agents/hermes/scripts/audit-sweep.sh. Probed on /status as service `cron.audit`.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-audit",
      kind: "cron",
      schedule: { time: "01:00", tz: "Europe/Amsterdam" },
    },
    statusDescription: "nightly one-domain codebase audit → a PR",
    title: "Nightly audit",
    weights: { status: "secondary" },
  },
  {
    exposedContent: [
      "05:00 reviewer for the nightly audit PR — fix-small-and-merge on green CI, else comment + hold (claude -p)",
    ],
    kind: "cron",
    name: "cron.audit-review",
    operatorNotes:
      "05:00 Amsterdam, a rave-02 host systemd timer (docs/agents/hermes/audit-review-timer/). Reviews the newest open audit/* PR adversarially; merges when required checks are green and nothing high-impact remains, else comments and leaves it for the operator. Source: docs/agents/hermes/scripts/audit-review-sweep.sh. Probed on /status as service `cron.audit-review`.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-audit-review",
      kind: "cron",
      schedule: { time: "05:00", tz: "Europe/Amsterdam" },
    },
    statusDescription: "reviews + merges the nightly audit PR",
    title: "Audit reviewer",
    weights: { status: "secondary" },
  },
  {
    exposedContent: [
      "nightly Sentry triage — reads the day's unresolved production errors and opens a fix PR for each straightforward one, files the rest (claude -p, subscription auth)",
    ],
    kind: "cron",
    name: "cron.sentry-triage",
    operatorNotes:
      "03:30 Amsterdam, a rave-02 host systemd timer (docs/agents/hermes/sentry-triage-timer/). Its OWN cron, not the audit rotation — checks Sentry every night. A full agentic claude -p session: reconciles merged fixes (resolves their issues), pulls new unresolved issues from both Sentry projects, fixes the straightforward ones (one PR each, `Sentry-Issue:` refs so a merge resolves the issue), files the rest to docs/sentry-backlog.md. The deterministic Sentry API work lives in sentry-triage-sweep.ts so the Sentry token never enters claude. Subscription auth (CLAUDE_CODE_OAUTH_TOKEN), zero OpenRouter tokens. Operator-gated on SENTRY_TRIAGE_TOKEN (skips cleanly until set). Source: docs/agents/hermes/scripts/sentry-triage-sweep.sh. Probed on /status as service `cron.sentry-triage`.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-sentry-triage",
      kind: "cron",
      schedule: { time: "03:30", tz: "Europe/Amsterdam" },
    },
    statusDescription: "nightly triage of production errors → fix PRs",
    title: "Sentry triage",
    weights: { status: "secondary" },
  },
];

// ── Selectors ────────────────────────────────────────────────────────────────

/** The weight ladder, loudest first — the sort order for a context's menu. */
const WEIGHT_ORDER: Record<SurfaceWeight, number> = {
  hidden: 3,
  primary: 0,
  secondary: 1,
  tertiary: 2,
};

/**
 * The LIVE catalog — every surface except the `pending` (pre-staged, dark) ones.
 * Every selector reads through this, so a `pending` surface never reaches a menu, a
 * probe, the dev-row, llms.txt, or the sitemap. A raw `SURFACES`-iterating consumer
 * (the MCP `get_status` labels, the CLI status labels) should iterate this instead.
 * Flip a surface's `pending` off and it appears in all of them at once.
 */
export function liveSurfaces(): Surface[] {
  return SURFACES.filter((surface) => surface.pending !== true);
}

/**
 * Every surface DISPLAYED IN `ctx` (i.e. carrying a weight for that context),
 * sorted loudest-first (primary → hidden), ties broken by catalog order. This is
 * the per-context menu/nav builder: `surfacesForContext("web")` is the homepage's
 * ranked surface list; `surfacesForContext("ssh")` is the rave terminal's. `pending`
 * surfaces are excluded (see `liveSurfaces`).
 */
export function surfacesForContext(ctx: SurfaceContext): Surface[] {
  return liveSurfaces()
    .filter((surface) => surface.weights[ctx] !== undefined)
    .sort((a, b) => {
      const wa = a.weights[ctx];
      const wb = b.weights[ctx];
      // Both are defined (the filter guaranteed it); fall back keeps TS happy.
      return (wa ? WEIGHT_ORDER[wa] : 0) - (wb ? WEIGHT_ORDER[wb] : 0);
    });
}

/**
 * Every surface at the given weight IN A CONTEXT, in catalog order. The per-context
 * successor to the old global `surfacesByWeight`: name the context you are ranking
 * for. `surfacesByWeight("web", "primary")` is the web homepage's loud front doors.
 * `pending` surfaces are excluded (see `liveSurfaces`).
 */
export function surfacesByWeight(ctx: SurfaceContext, weight: SurfaceWeight): Surface[] {
  return liveSurfaces().filter((surface) => surface.weights[ctx] === weight);
}

/** Every LIVE surface at the given kind, in catalog order (`pending` excluded). */
export function surfacesByKind(kind: SurfaceKind): Surface[] {
  return liveSurfaces().filter((surface) => surface.kind === kind);
}

/**
 * Every LIVE surface that carries a `probeConfig` — the set a `/status` prober walks
 * (`pending` excluded, so a pre-staged surface is not probed until it goes live).
 * Narrows the type so a consumer can read `surface.probeConfig` without a guard.
 */
export function statusProbes(): Array<Surface & { probeConfig: ProbeConfig }> {
  return liveSurfaces().filter(
    (surface): surface is Surface & { probeConfig: ProbeConfig } =>
      surface.probeConfig !== undefined,
  );
}

/** Every on-box Hermes cron surface, in catalog order. */
export function cronSurfaces(): Surface[] {
  return surfacesByKind("cron");
}
