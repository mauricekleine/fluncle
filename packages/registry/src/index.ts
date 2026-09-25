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
  | "extension"
  | "app";

export type SurfaceWeight = "primary" | "secondary" | "tertiary" | "hidden";

export type SurfaceContext = "web" | "ssh" | "cli" | "status";

export type SurfaceWeights = Partial<Record<SurfaceContext, SurfaceWeight>>;

export type CronSchedule = {
  time: string;

  tz: string;

  weekday?: number;
};

export type ProbeConfig = {
  kind: "http" | "cron";

  cronName?: string;

  cadenceMs?: number;

  schedule?: CronSchedule;

  timeoutMs?: number;
};

export type RunLedgerWriter = {
  expectedIntervalMs: number;

  unit: string;
};

export type Surface = {
  name: string;
  kind: SurfaceKind;

  title?: string;

  statusDescription?: string;

  weights: SurfaceWeights;

  url?: string;

  subdomain?: string;

  route?: string;

  command?: string;

  exposedContent: string[];

  apiFormat?: string;

  probeConfig?: ProbeConfig;

  discoveryUrl?: string;

  pending?: boolean;

  operatorNotes?: string;
};

const SITE = "https://www.fluncle.com";

const PROBE_CADENCE_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;

const MINUTE_MS = 60 * 1000;

export const SURFACES: readonly Surface[] = [
  {
    exposedContent: [
      "the front door — search with real example queries, one edited lead finding, the newest findings, what just came out, and the four routes into the wider archive",
    ],
    kind: "web_route",
    name: "web.home",
    operatorNotes: "The Worker root. galaxy./radio. rewrite their root to /galaxy and /radio.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/",
    url: `${SITE}/`,
    weights: { web: "primary" },
  },
  {
    exposedContent: ["the archive — every certified finding, newest first, cover-led"],
    kind: "web_route",
    name: "web.findings",
    operatorNotes:
      "The cover-led archive page the root used to be. Carries the Stories viewer (?story=<logId>, masked to /log/<id>); /?story= 301s to /log/<id>.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/findings",
    url: `${SITE}/findings`,
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
    weights: { web: "primary" },
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
      "The new-releases lens over the whole archive — the SEO answer to 'new dnb releases', a weekly-refreshed query. Orders by tracks.release_date (when a tune CAME OUT), never findings.added_at (when Fluncle FOUND it) — the two are unrelated, and the copy never claims he found these. A HUB, so it is always indexable + listed unconditionally in the sitemap (like /albums), never the per-detail thin-content gate. The window read rides the release-date prefix of the tracks_release_date_track_id_idx btree so it stays a bounded range scan as the catalogue grows (lib/server/fresh.ts). The INDEX is always-200, so it is HTTP-probeable.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/fresh",
    url: `${SITE}/fresh`,
    weights: { web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/search — the persistent, linkable search surface: one `?q=` carries a coordinate, an entity name, a natural-language filter, or a sonic reference, and the answer is server-rendered from the URL",
      "/search?q=<query> — a shareable, reload-safe result set over the whole archive (findings and the wider catalogue)",
    ],
    kind: "web_route",
    name: "web.search",
    operatorNotes:
      "The PERSISTENT half of search — the addressable counterpart to the ⌘K palette, which stays the accelerator and hands off here (components/search/search-command.tsx). It calls the SAME primitive, `searchArchive` (lib/server/search.ts), through a serverFn, so all four resolution tiers, the certified-first ranking, the catalogue rule, and the degradation contract are the ones docs/search.md already specifies; nothing is re-resolved. THE WHOLE QUERY STATE IS ONE PARAM, because the resolver takes one string — a coordinate, a name, a sentence, and a sonic reference all arrive as `q`. A coordinate/entity `redirect` is deliberately NOT followed here (the palette may; a persistent URL that bounced would be un-shareable and a back-button trap): the resolved row is rendered as the first result instead. The field commits on SUBMIT, never per keystroke, so history holds one entry per real query. It is a real `<form method=get action=/search>`, so search works with no JS. The BARE surface is indexable, in the sitemap, and carries the WebSite SearchAction; ANY `?q=` view is noindex, follow with its canonical collapsed onto the bare page (the /tracks filtered-view rule, and the standard posture for an internal results page). The INDEX is always-200, so it is HTTP-probeable.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/search",
    url: `${SITE}/search`,
    weights: { web: "primary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/tracks — the whole list: every track Fluncle holds (certified findings + the wider catalogue), newest release first, filterable by release year, tempo, key, label, and galaxy",
      "/track/:trackId — one archive recording: its artists, record, label, release date, tempo and key, a bounded preview, the services the archive holds a link to, and what sits close to it in sound",
    ],
    kind: "web_route",
    name: "web.tracks",
    operatorNotes:
      "The top-level track index — the whole archive as one browse list, findings in full voice and the catalogue rows in the unlit register (DESIGN.md). Ordered by tracks.release_date (what came out), never findings.added_at (the Found Rule), numbered-paginated (?page=N) over the tracks_release_date_track_id_idx btree with a quiet YEAR fast lane, so a crawler with no JS walks the whole list (lib/server/tracks-hub.ts). The filter params MIRROR the search vocabulary verbatim (yearMin/yearMax, bpmMin/bpmMax, key, label; galaxy is the one extension). The bare HUB is always indexable + in the sitemap, each page self-canonical; ANY filter param present flips it to noindex, and paged bare URLs stay out of the sitemap. The INDEX is always-200, so it is HTTP-probeable. The DETAIL page /track/:trackId is the archive recording's own destination, keyed on the row's permanent primary key; a CERTIFIED track 301s to /log/<coordinate> (that URL and its meaning are unchanged) and a stamped duplicate 301s to its principal. It carries its own EVIDENCE gate: one SQL expression (TRACK_PAGE_INDEXABLE_WHERE) drives both the page's robots directive and its sitemap membership, so a low-evidence page serves 200 + noindex,follow and stays out of the tracks sitemap child by construction. See docs/track-destination.md.",
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
      "The public sonic-cluster lens (browse-by-feel RFC). Distinct from the game's /galaxy + galaxy.fluncle.com. No probeConfig — the launch gate 404s the index until the operator has NAMED the whole map, so there is no always-200 URL to GET-probe; the api.galaxies op (always 200, empty list pre-launch) is the probe surface. A galaxy below the member floor renders noindex. The rave terminal carries a galaxies browse screen (ssh weight). The two GENERATED agent-discovery documents advertise the lens once the map is named (the `Accept: text/markdown` homepage and llms-full.txt, both gated on `isGalaxyMapFullyNamed`); the static apps/web/public/llms.txt cannot, because a file on disk has no way to read that gate.",
    route: "/galaxies",
    url: `${SITE}/galaxies`,
    weights: { ssh: "secondary", web: "secondary" },
  },
  {
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "/identity — look a recording up by ISRC, MusicBrainz recording id, or Log ID",
      "/identity/:key — one recording's identifiers and platform links, each carrying whether Fluncle found it, looked and found nothing, will not look, or hands out no such link",
    ],
    kind: "web_route",
    name: "web.identity",
    operatorNotes:
      "The public face of the identity envelope (lib/server/identity-envelope.ts); the machine twin is `get_track`'s identity projection (?identity= / ?isrc= / ?mbid=), and both read the same module so page and API cannot diverge — except on Apple Music, the one audience-scoped field: the page reads `first-party` and renders an Apple link as /log does, the API answers `unsupported` because Apple's terms bar passing those links on. The DOOR is probeable (always 200, and a bare GET with no ?key= renders the explainer); the keyed page is not, and it renders `noindex, follow` on purpose — one recording is reachable under up to three identifiers, so indexing them would put three near-identical URLs in front of one answer at catalogue scale. Only the door is in the sitemap. Both the page's server fn and the op charge the SAME two dials (identity-dials.ts: 30/min + 1,000/day per caller), so the meter cannot be dodged by switching doors; a spent dial renders as a calm page state, never a fault. The keyed page answers 200 with an honest 'nothing under this identifier' rather than 404ing, because an unknown key is a real question with a real answer.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/identity",
    url: `${SITE}/identity`,
    weights: { web: "tertiary" },
  },
  {
    exposedContent: [
      "the signed-in account door: a listener's Galaxy progress, the findings and sets they saved, the tracks they submitted, and their account settings",
    ],
    kind: "web_route",
    name: "web.account",
    operatorNotes:
      "A WORKSTATION, not a lore page (VOICE.md §5 The Three Areas): chrome register throughout. PUBLIC and always 200 — signed out it serves the sign-in / join door, so it is honestly HTTP-probeable; every door's data is session-scoped and read on the server. `noindex` (a private per-user surface, self-canonical), so it stays out of the sitemap and llms.txt while remaining a registered, advertised surface: the nav's `Your account` CTA points here. Source: apps/web/src/routes/account.tsx + components/account.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/account",
    url: `${SITE}/account`,
    weights: { web: "secondary" },
  },
  {
    exposedContent: [
      "ChatDnB — a chat with Fluncle over his own archive; he answers from his certified findings",
    ],
    kind: "web_route",
    name: "web.chat",

    operatorNotes:
      "The public face of ChatDnB. Gated to verified-email accounts (the rollout cohort); the server route re-checks the session, the verification, the origin/CSRF, and the rate dials on every turn. PENDING = registered but dark until the rollout opens to everyone.",
    pending: true,
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/chat",
    url: `${SITE}/chat`,
    weights: { web: "secondary" },
  },
  {
    exposedContent: [
      "the per-listener recommendations door: a signed-in listener names the tracks they love, the Ear lines the catalogue up against those seeds, and the result lands as a playlist on Fluncle's own Spotify, refreshed weekly",
    ],
    kind: "web_route",
    name: "web.recommendations",

    operatorNotes:
      "E1/E2, the recommendation machine's public door. Three states off the session (anonymous pitch, unverified pointer, verified surface); the DRAFT read is the one place the live vector scan sits on a read path, rate-limited per user and degrading to empty rather than blocking the door. PENDING = registered but dark until the rollout opens.",
    pending: true,
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/recommendations",
    url: `${SITE}/recommendations`,
    weights: { web: "secondary" },
  },

  {
    exposedContent: [
      "the Galaxy factory — a draggable map of a finding's whole life, from the first CMD+F through the enrichment sweeps to the launch into the Galaxy",
    ],
    kind: "web_route",
    name: "web.pipeline",
    operatorNotes:
      "A public console page (VOICE.md §5 The Three Areas), written in the builder's-tour register. Client-only DOM/SVG/canvas — the whole map is a chunk loaded in useEffect, so it costs the archive's bundle nothing — over an SSR shell that answers 200, so it is HTTP-probeable. `noindex` (a for-the-nerds machinery view, not a search surface), so it stays out of the sitemap; the nav's Crew section links it. Source: apps/web/src/routes/pipeline.tsx + src/pipeline.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/pipeline",
    url: `${SITE}/pipeline`,
    weights: { web: "tertiary" },
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
      "the R2 media zone: each finding's video bundle and mixtape audio",
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
      "the Tor onion mirror of www.fluncle.com: the archive, API, RSS, and MCP over Tor",
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

  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "the feed as JSON — findings and published mixtapes, newest found first, cursor-paginated (limit max 48, cursor)",
    ],
    kind: "api",
    name: "api.findings",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/api/v1/findings",
    url: `${SITE}/api/v1/findings`,
    weights: { status: "secondary", web: "primary" },
  },
  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/api/v1/openapi.json`,
    exposedContent: [
      "every track Fluncle holds as JSON, newest release first, numbered pages (page); certified=true narrows to findings, certified=false to the rest, omitted returns both",
    ],
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
    route: "/api/v1/health",
    url: `${SITE}/api/v1/health`,
    weights: { status: "tertiary", web: "tertiary" },
  },

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

  {
    apiFormat: "application/xml",
    exposedContent: ["the XML sitemap index of every public page"],
    kind: "discovery",
    name: "discovery.sitemap",
    operatorNotes:
      "A sitemap INDEX, not a flat urlset: the URLs live in children at /sitemap/<kind>-<n>.xml, ONE CHILD PER ENTITY TYPE (pages/findings/artists/labels/albums/galaxies/logbook/docs), each auto-paged under Google's 50,000-URL ceiling so a breach cannot happen rather than merely not having happened yet. robots.txt still names this one URL — a crawler discovers the children from here. Splitting per entity type is also the diagnostic: Search Console reports coverage PER sitemap, so each entity type gets its own submitted/indexed count.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/sitemap.xml",
    url: `${SITE}/sitemap.xml`,
    weights: { web: "secondary" },
  },
  {
    apiFormat: "application/xml",
    exposedContent: [
      "one child sitemap, per entity type: the pages / findings / artists / labels / albums / galaxies / logbook / docs URLs, auto-paged",
    ],
    kind: "discovery",
    name: "discovery.sitemap-shard",

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
    apiFormat: "text/plain",
    exposedContent: [
      "RFC 9116 security.txt — where to send a vulnerability report, in the one place a researcher looks first",
    ],
    kind: "discovery",
    name: "discovery.security-txt",
    operatorNotes:
      "A static file, apps/web/public/.well-known/security.txt. It carries an `Expires` field the RFC requires a responder to keep in the future — when it lapses, a reporter reads the contact as stale. No probeConfig, exactly like robots.txt and llms.txt: a static asset the Worker never computes.",
    route: "/.well-known/security.txt",
    url: `${SITE}/.well-known/security.txt`,
    weights: { web: "tertiary" },
  },
  {
    apiFormat: "text/plain",
    exposedContent: ["humans.txt — who made this, who is thanked, and what it is built with"],
    kind: "discovery",
    name: "discovery.humans",
    operatorNotes:
      "A static file, apps/web/public/humans.txt — the human counterpart to robots.txt. Machine-fetched by convention, never browsed, which is why it sits under `discovery` beside robots.txt rather than as a web route.",
    route: "/humans.txt",
    url: `${SITE}/humans.txt`,
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
    exposedContent: ["one developer-doc page as clean Markdown, at `/docs.md/<slug>`"],
    kind: "discovery",
    name: "discovery.docs-markdown",
    operatorNotes:
      'The Markdown twin of every /docs page — front-matter-free, the title as the H1, the description as the lede, then the precompiled body (`includeProcessedMarkdown` in source.config.ts → `page.data.getText("processed")`). It is the endpoint behind the page-actions affordance ("View as Markdown", "Copy page", and the Open in ChatGPT/Claude/Cursor links, which carry this URL so the assistant pulls the clean Markdown), and each /docs page advertises it as `<link rel="alternate" type="text/markdown">` (routes/-docs-head.ts). A machine-FETCHED document rather than a page, so it is catalogued as `discovery` next to llms.txt. No probeConfig: the route is slug-parameterized, so there is no fixed URL to GET-probe (the `discovery.oembed` / `web.artist` precedent) — the post-deploy probe skips it for the same reason it skips /artist/:slug/fresh.xml. Source: apps/web/src/routes/docs[.]md.$.ts (a pure splat, mounted at /docs.md/$).',
    route: "/docs.md/:slug",
    url: `${SITE}/docs.md/cli`,
    weights: { web: "tertiary" },
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
    exposedContent: [
      "the A2A agent card — Fluncle's actionable public skills (search, list, read, submit, subscribe)",
    ],
    kind: "discovery",
    name: "discovery.agent-card",
    operatorNotes:
      "The cross-vendor twin of `discovery.mcp-server-card`, served by handleAgentDiscovery (apps/web/src/lib/server/agent-discovery.ts) at the canonical A2A path AND the legacy short `/.well-known/agent.json` — same bytes, so only the canonical one is catalogued here. Its skills map 1:1 onto real public ops, with the MCP tool list as the source of truth.",
    route: "/.well-known/agent-card.json",
    url: `${SITE}/.well-known/agent-card.json`,
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

  {
    apiFormat: "text/x-shellscript",
    discoveryUrl: `${SITE}/llms.txt`,
    exposedContent: [
      "the one-line CLI installer: picks the right `fluncle` binary for the machine off the latest GitHub release and drops it in place",
    ],
    kind: "discovery",
    name: "discovery.cli-installer",
    operatorNotes:
      "`curl -fsSL https://www.fluncle.com/cli/latest.sh | sh`, the install path the /docs/cli page, the rave terminal's Install CLI screen, the CLI's own update hint, and llms.txt (§Tools) all point at. A machine-FETCHED document rather than a page, which is why it is catalogued as `discovery` next to robots.txt and llms.txt: nothing about it is browsable, and its only reader is a shell. Always 200 (it is generated in the route, no upstream call), so the post-deploy probe asserts a non-empty body on it. Source: apps/web/src/routes/cli/latest[.]sh.ts.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    route: "/cli/latest.sh",
    url: `${SITE}/cli/latest.sh`,
    weights: { web: "tertiary" },
  },

  {
    apiFormat: "application/json",
    discoveryUrl: `${SITE}/.well-known/mcp/server-card.json`,
    exposedContent: [
      "the archive as MCP tools (Streamable HTTP, no auth): list_findings, list_tracks, list_fresh, get_track, get_random_track, get_status, search_archive, get_artist, get_label, build_set, list_similar_artists, list_album_catalogue, list_artist_catalogue, list_label_catalogue, list_artists, list_albums, list_labels, submit_track, subscribe_newsletter, plus the MCP-only search_tracks (Spotify candidate search, not an archive read)",
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

  {
    command: "ssh rave.fluncle.com",
    exposedContent: [
      "the rave terminal TUI: Latest findings, Fresh releases, Artist archive, Sonic galaxies, Mixtape archive, Random banger, Submit, Subscribe, Install CLI, System status, About",
      "deep-register one-shots: `ssh rave.fluncle.com latest|fresh|random`",
    ],
    kind: "ssh",
    name: "ssh.rave",
    operatorNotes: "apps/ssh (Go Wish/Bubble Tea). Probed on /status as service `ssh`.",
    probeConfig: { cadenceMs: PROBE_CADENCE_MS, kind: "http", timeoutMs: PROBE_TIMEOUT_MS },
    subdomain: "rave.fluncle.com",
    weights: { ssh: "primary", status: "secondary", web: "primary" },
  },

  {
    command: "fluncle recent",
    exposedContent: ["the latest bangers, newest first (alias `list`)"],
    kind: "cli",
    name: "cli.recent",
    weights: { cli: "primary", web: "tertiary" },
  },
  {
    command: "fluncle fresh",

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
    exposedContent: ["every artist Fluncle holds, A to Z (bare `slug` looks one up)"],
    kind: "cli",
    name: "cli.artists",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle albums",
    exposedContent: ["every album Fluncle holds, A to Z (bare `slug` looks one up)"],
    kind: "cli",
    name: "cli.albums",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle labels",
    exposedContent: ["every label Fluncle holds, A to Z (bare `slug` looks one up)"],
    kind: "cli",
    name: "cli.labels",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle galaxies",
    exposedContent: [
      "wander Fluncle's sonic galaxies, the browse-by-feel lens (bare `slug` opens one)",
    ],
    kind: "cli",
    name: "cli.galaxies",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle search",
    exposedContent: ["search the archive by coordinate, track, artist, label, or album"],
    kind: "cli",
    name: "cli.search",
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
    exposedContent: ["the archive throws a banger back"],
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
    command: "fluncle login",
    exposedContent: ["link this device to your Fluncle account, so your Galaxy progress syncs"],
    kind: "cli",
    name: "cli.login",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle me",
    exposedContent: ["your account and Galaxy progress (sign in with `fluncle login`)"],
    kind: "cli",
    name: "cli.me",
    weights: { cli: "secondary" },
  },
  {
    command: "fluncle logout",
    exposedContent: ["unlink this device from your account"],
    kind: "cli",
    name: "cli.logout",
    weights: { cli: "tertiary" },
  },
  {
    command: "fluncle tracks get",
    exposedContent: ["look up one finding by id or Log ID"],
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
    command: "fluncle status",
    exposedContent: ["how Fluncle's services are holding up (the /status board, in the terminal)"],
    kind: "cli",
    name: "cli.status",
    operatorNotes:
      "Reads the public status snapshot and labels each service off `liveSurfaces()` — a registry CONSUMER as well as a registry entry. Source: apps/cli/src/commands/status.ts.",
    weights: { cli: "tertiary" },
  },
  {
    command: "fluncle admin",
    exposedContent: [
      "the operator/agent command group (hidden): a bare `queue` read plus plural groups — tracks (publish|update|enrich|embed|capture|video|draft|social|preview|observe|context|note|work|get|list|queue|mixable-order|requeue-analysis|vehicles), artifacts (register|status|bootstrap|bootstrap-checkpoint|activate|list|checkpoint|inactivate|compact), receipts (get|repair), catalogue (the crawler + The Ear), frontier, labels, artists, albums, galaxies, notes, observations, clips, recordings, publish, capture, mixtapes, newsletter, logbook, prompts, submissions, reach, backfills, migrations, auth",
    ],
    kind: "cli",
    name: "cli.admin",
    operatorNotes: "Authenticated admin/agent tier. The enrichment crons drive a subset of these.",
    weights: { cli: "hidden" },
  },

  {
    exposedContent: [
      "Fluncle Lens — the browser extension that finds fluncle:// coordinates on any page and links each to its /log/<coord> finding (with a hover card from the public API)",
    ],
    kind: "extension",
    name: "extension.lens",

    operatorNotes:
      "Fluncle Lens (apps/extension), MV3, LIVE on the Chrome Web Store (published 2026-06-29). Store listing reachability is Google's, not ours, so it is not on the /status board.",
    url: "https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk",
    weights: { web: "secondary" },
  },

  {
    exposedContent: [
      "Fluncle for iOS — the archive as a native app: the Feed, the Archive, the Decks, the Radio, and the Mixtapes, each finding opening its own /log screen, plus a submit door and push when a new banger lands",
    ],
    kind: "app",
    name: "app.ios",

    operatorNotes:
      "Fluncle for iOS (apps/mobile), LIVE on the App Store (approved 2026-07-29). Store listing reachability is Apple's, not ours, so it is not on the /status board — the extension.lens ruling: a vendor store would bot-block or redirect a bare GET and read back as a false 'down'.",
    url: "https://apps.apple.com/app/id6790080540",
    weights: { web: "secondary" },
  },

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
      "nightly (03:20 Amsterdam), run by a Hermes host systemd timer (docs/agents/hermes/cluster-timer/). Assignment-ONLY + idempotent (a no-op on an unchanged corpus): assign each finding to its nearest stored centroid, recompute centroids as members' means, retire an emptied galaxy, consume an operator split_requested_at (a k=2 fit). Zero LLM tokens; sub-second CPU. A full k=9 fit is an OPERATOR act (--cold-start / --remint), never scheduled. Source: docs/agents/hermes/scripts/cluster-sweep.* + cluster.py. See docs/agents/cluster-engine.md.",
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
      "daily at 07:20 Amsterdam, run by a Hermes host systemd timer (docs/agents/hermes/label-releases-timer/). The FRESHNESS TAP (D8): MusicBrainz WALKS the graph (cron.crawl) but lags a release ~2 weeks; Spotify has it day one, so this mints METADATA-ONLY catalogue rows (a `tracks` row with no `findings` row) for each ENABLED seed label's fresh releases with their real dates — closing the /fresh lag cliff. The WORKER does all of it (`backfill_label_releases`, agent tier): it searches the official Spotify API (`label:\"<name>\" tag:new`), reads each hit as a SINGLE `GET /albums/{id}` then `GET /tracks/{id}` (the batch endpoints are 403 at our tier), and mints. The box sweep is a thin HTTP TRIGGER that POSTs bounded passes with the agent token — no vendor token, no CLI dependency (a pinned box CLI missing a flag broke an earlier run). The gate, both required: artist-grounding (an album's Spotify artist already in `artists.spotify_artist_id` — the PRIMARY anchor that stops cross-genre homonym junk) AND an EXACT fold-match of the seed name in the ℗/© copyright; an album with no release_date is dropped outright (/fresh could never show it). BUDGET: the tap shares the official app's per-app window with the user-facing paths, so it paces itself against the shared call meter and stops at a FRACTION of the window (its own ceiling) — user write paths get the window, the tap takes only slack. Hitting that ceiling ends the pass cleanly and the durable per-label cadence stamps resume it next tick. It certifies nothing, publishes nothing, never widens the graph (no new labels, no artist hops). Deduped against the MB crawl from both directions (Spotify id/uri/ISRC + same-album title fold). No vendor spend and zero LLM tokens. Source: docs/agents/hermes/scripts/label-releases-sweep.*. See docs/catalogue-crawler.md.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-label-releases",
      kind: "cron",
      schedule: { time: "07:20", tz: "Europe/Amsterdam" },
    },
    statusDescription: "taps day-one releases from the enabled labels",
    title: "Freshness tap",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "checks pipeline yield against measured backlog and alerts the operator on sustained stalls",
    ],
    kind: "cron",
    name: "cron.pipeline-watch",
    operatorNotes:
      "Every 15m from a host calendar timer. Reads sweep markers and agent-tier status/worklist counters; alerts Discord on incident open, reminders, and recovery. Source: docs/agents/hermes/scripts/pipeline-watch.*.",
    probeConfig: { cadenceMs: 15 * MINUTE_MS, cronName: "fluncle-pipeline-watch", kind: "cron" },
    statusDescription: "watches for stalled track processing",
    title: "Track watch",
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
    exposedContent: [
      "recover missing catalogue ISRCs through free Deezer search → feed the exact-ISRC Spotify anchor queue",
    ],
    kind: "cron",
    name: "cron.isrc-recovery",
    operatorNotes:
      "every ten minutes, run by a host systemd timer (docs/agents/hermes/isrc-recovery-timer/). Selects un-anchored catalogue rows whose stored has_isrc mirror is false, searches Deezer once with the server-supplied query, and POSTs up to five candidates to the existing agent-tier `resolve_anchor` op with `spotifySearch: false`. The Worker re-runs its shared identity + duration gate and writes only a verified ISRC; that stored mirror then feeds the row into cron.anchor's high-precision exact-ISRC head. This sweep NEVER calls `anchor_track` and spends zero Apify. Deezer is tokenless, so the box's existing FLUNCLE_API_TOKEN is the only secret. Requests are sequential and paced; HTTP-200 Deezer quota bodies are classified separately from genuine empty results, and a short quota streak aborts the rest of the tick visibly. Source: docs/agents/hermes/scripts/isrc-recovery-sweep.*.",
    probeConfig: {
      cadenceMs: 10 * MINUTE_MS,
      cronName: "fluncle-isrc-recovery",
      kind: "cron",
    },
    statusDescription: "recovers catalogue ISRCs before Spotify anchoring",
    title: "ISRC recovery",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "mirror the anchored, explicitly allowlisted public catalogue into the shared read-only device replica",
    ],
    kind: "cron",
    name: "cron.device-mirror",
    operatorNotes:
      "hourly, run by a host systemd timer (docs/agents/hermes/device-mirror-timer/). Explicitly synchronizes one restart-safe local embedded replica, materializes the anchored track IDs once, derives and validates one allowlisted generation locally, then stages bounded changes and atomically cuts the complete verified generation into the shared device database. Sync, derivation, upload, validation, or cutover failure leaves the previous generation visible; rebuilding the target database remains forbidden because it would reset the libSQL replication log and force every device to bootstrap again. A schema-version mismatch stops for an operator migration. Zero LLM tokens. Source: docs/agents/hermes/scripts/device-mirror.*.",
    probeConfig: {
      cadenceMs: 60 * MINUTE_MS,
      cronName: "fluncle-device-mirror",
      kind: "cron",
    },
    statusDescription: "keeps the offline catalogue replica in step",
    title: "Device catalogue mirror",
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
    command: "fluncle admin backfills artist-credits",
    exposedContent: [
      "mint identity-true artists from MusicBrainz credits for slice 0's zero-matched residual → track_artists edges",
    ],
    kind: "cron",
    name: "cron.artist-credits",
    operatorNotes:
      "every 5m, run by a rave-02 HOST systemd timer (docs/agents/hermes/artist-credits-timer/). The MB CREDIT SWEEP (RFC artist-primary-capture, slice 1b): the sibling that completes what `backfill_artist_edges` (slice 0) could not. Slice 0's name-fold left a ~14.3k ZERO-MATCHED residual (a track it stamped but wrote no edge — no credited name folded to an existing identity), and those are exactly the tracks capture-authorization (slice 1) cannot reason about, since it matches BY IDENTITY through the `track_artists` graph. This sweep picks up that residual: for each zero-matched track carrying a MusicBrainz recording identity (`mb_recording_id`, or the `mb_<recording-mbid>` PK a crawler-born row carries), ONE paced `/recording/<mbid>?inc=artist-credits` lookup through the shared MusicBrainz client names its credited artists WITH their MB artist ids, and each resolves down a three-rung ladder: an EXACT `mbid` match, else an ADOPT (the credit name folds unambiguously onto an existing artist with no mbid — the common case, since the residual is dominated by compound credit strings like 'Sub Focus & Dimension' whose members Fluncle already holds as Spotify-keyed rows; adopting `coalesce`s the mbid onto that row instead of minting a duplicate, the split-identity guard), else a MINT of a fresh identity-true row (`mintArtistByMbid` — a real MBID is identity, the licence slice 0 lacked). Fail-closed on any ambiguity (a shared fold, or a fold whose row carries a different mbid) → mint, never a wrong merge. Then the `track_artists` edges are written. A zero-matched track with NO MB identity is TERMINALLY SKIPPED (stamped, never retried). METADATA / GRAPH IDENTITY ONLY — it certifies nothing and publishes nothing (agent tier, the `backfill_recording_mbids` precedent). Worker-paced (the box holds no MusicBrainz budget): a SMALL bounded batch per tick (each row is one ~1.1s MB call), 1 req/s, circuit-broken on a throttle, with a 60s response budget that pauses mid-page and resumes on the next request. The `tracks` row carries the durable per-row reliability state — its OWN `artist_credits_backfilled_at` stamp, DISTINCT from slice 0's `artist_edges_backfilled_at` (never disturbed). The ~14.3k residual drains at ~40/tick over ~a day and a half. Zero LLM tokens. Source: docs/agents/hermes/scripts/artist-credits-sweep.*. See docs/artist-relationship.md.",
    probeConfig: { cadenceMs: 5 * MINUTE_MS, cronName: "fluncle-artist-credits", kind: "cron" },
    statusDescription: "mints artists from MusicBrainz credits for the residual",
    title: "Artist credits",
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
    command: "fluncle admin labels list --seed-state undecided",
    exposedContent: ["read the undecided crawl-seed pile and report whether a triage round is due"],
    kind: "cron",
    name: "cron.label-triage",
    operatorNotes:
      "daily. A PURE trigger — zero model tokens, one countless admin read and a sort. Fires only when 40+ NEVER-LOOKED labels have accumulated; stale ones ride along but never trigger a round. It cannot rule: recording a finding is record_label_triage (agent tier) and ruling is update_label (operator tier), which 403s the box token. The batched research leg is deliberately unwired until the gate proves it reports honestly. Source: docs/agents/hermes/scripts/{label-triage-sweep.ts,label-triage-sweep.sh}.",
    probeConfig: { cadenceMs: 24 * 60 * MINUTE_MS, cronName: "fluncle-label-triage", kind: "cron" },
    statusDescription: "reports when the label pile needs a round",
    title: "Label triage gate",
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
    command:
      "fluncle admin backfills discogs && fluncle admin backfills lastfm && fluncle admin backfills apple-music && fluncle admin backfills apple-catalogue && fluncle admin backfills beatport && fluncle admin backfills discogs-facts",
    exposedContent: [
      "Discogs id + Last.fm love + Apple Music link + Beatport link repair, findings then catalogue, then each record's catalogue number (--no-agent, Worker HTTP)",
    ],
    kind: "cron",
    name: "cron.backfill",
    operatorNotes: "every 30m. Pure HTTP driving, zero LLM tokens. Agent tier.",
    probeConfig: { cadenceMs: 30 * MINUTE_MS, cronName: "fluncle-backfill", kind: "cron" },
    statusDescription: "repairs Discogs ids, Last.fm loves, and Apple Music links",
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
      "every 10m. Pure HTTP trigger, zero LLM tokens. Agent tier (fills the public URL only — publishes nothing). The box's baked CLI predates the `--capture` verb, so the cron curls POST /api/v1/admin/social/posts/capture directly; the Worker polls Postiz and writes back. Source: docs/agents/hermes/scripts/social-capture-sweep.sh. Probed on /status as cron.social-capture.",
    probeConfig: { cadenceMs: 10 * MINUTE_MS, cronName: "fluncle-social-capture", kind: "cron" },
    statusDescription: "the live YouTube and TikTok URLs for each posted video",
    title: "Social links",
    weights: { status: "hidden" },
  },
  {
    exposedContent: [
      "poll Twitch for the live set → POST the live state that lights the cross-surface callout (--no-agent)",
    ],
    kind: "cron",
    name: "cron.live",
    operatorNotes:
      "every 1m, run by a rave-02 host systemd timer (docs/agents/hermes/live-timer/). Pure polling, zero LLM tokens. Mints/reuses a cached Twitch client-credentials app token, asks Helix whether the channel is streaming, and POSTs the raw state to the agent-tier record_live_state op — the Worker owns the transition detection and the crew callout. The poller is deliberately dumb and idempotent; auto-clear is READ-side (every surface treats a flag older than ~5m as offline), so a dead poller can never strand a permanent LIVE banner. Source: docs/agents/hermes/scripts/fluncle-live.sh. Probed on /status as cron.live.",
    probeConfig: { cadenceMs: MINUTE_MS, cronName: "fluncle-live", kind: "cron" },
    statusDescription: "watches for the live set",
    title: "Live poller",
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
    command: "fluncle admin digests send",
    exposedContent: [
      "send new releases from followed artists and labels to signed-in crew each Friday",
    ],
    kind: "cron",
    name: "cron.follow-digest",
    operatorNotes:
      "Friday 17:00 Amsterdam, a template-only host-timer sweep. The Worker owns recipient selection, the enabled-by-default kill switch, Resend idempotency keys, and per-call send cap. The box uses only its agent token. Source: docs/agents/hermes/scripts/follow-digest-sweep.*.",
    probeConfig: {
      cadenceMs: 7 * 24 * 60 * MINUTE_MS,
      cronName: "fluncle-follow-digest",
      kind: "cron",
      schedule: { time: "17:00", tz: "Europe/Amsterdam", weekday: 5 },
    },
    statusDescription: "sends new releases from the artists and labels you follow",
    title: "Your follows",
    weights: { status: "secondary" },
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
    exposedContent: [
      "nightly hub-counts reconciliation — re-derives renderable_track_count / certified_finding_count for every label/album/artist and corrects only the rows that drifted (--no-agent)",
    ],
    kind: "cron",
    name: "cron.reconcile-hub-counts",
    operatorNotes:
      "04:10 Amsterdam (after the 04:00 reach snapshot, before the 04:40 demand tick), a rave-02 host systemd timer (docs/agents/hermes/reconcile-hub-counts-timer/). The SELF-HEALING BACKSTOP under keystone 2's maintained hub counts: they are moved as DELTAS by every edge-writing path (recompute-from-truth measured 27,400 ms at 150k hosted vs ~200 ms for the delta form), and a maintained counter drifts silently — a missed write path, a non-atomic bulk op, or an out-of-band write (the catalogue-prune skill deletes tracks straight out of the database). Keystone 2's own rollout proved it on day one: the deploy-window skew left 44 artists / 3 albums / 1 label wrong until a manual reconcile. Walks the AGENT-tier reconcile_hub_counts op in bounded windows, one admitted database phase each: the Worker reads bounded keyset pages of entity rows beside their truth (never an aggregate inside a write transaction) and rewrites only disagreeing rows as compare-and-set point writes, so a concurrent maintained delta is never overwritten. The artists source is PINNED to `track_artists JOIN tracks` so orphaned edges never count. Idempotent; zero LLM tokens; no new secret. The corrected-row numbers are the operator's DRIFT AUDIT — journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT. Source: docs/agents/hermes/scripts/reconcile-hub-counts.*.",
    probeConfig: {
      cadenceMs: 24 * 60 * MINUTE_MS,
      cronName: "fluncle-reconcile-hub-counts",
      kind: "cron",
      schedule: { time: "04:10", tz: "Europe/Amsterdam" },
    },
    statusDescription: "keeps the archive's counts adding up",
    title: "Count check",
    weights: { status: "hidden" },
  },
  {
    command:
      "fluncle admin projections get --json; fluncle admin projections advance --target <track_due_work|crawl_due_work> --action repair --limit 500 --max-steps <adaptive> --no-terminal-status --json; fluncle admin projections advance --target <public_aggregates|artist_qualification> --action repair --limit 500 --max-steps <adaptive> --no-terminal-status --json",
    exposedContent: [
      "keep all four runtime projection families converged after their cutovers with one-read, serial, bounded repair (--no-agent)",
    ],
    kind: "cron",
    name: "cron.projection-maintenance",
    operatorNotes:
      "every 5m with per-firing jitter, run by a rave-02 host systemd timer (docs/agents/hermes/projection-maintenance-timer/). Reads bounded projection status exactly once; the track, crawl, and public cutovers gate their own families independently. Open indebted families run strictly serially: track and crawl get at most twenty pages of 500, then public aggregates and artist qualification get at most four pages of 500. Repair responses omit terminal status so those four commands cannot repeat the global status suite. Public aggregate repair also advances the bounded anchor cursor after marker debt drains. The agent may repair only these four fixed targets; rebuild, audit, and every cutover mutation remain operator-only. Zero LLM tokens; no new secret.",
    probeConfig: {
      cadenceMs: 5 * MINUTE_MS,
      cronName: "fluncle-projection-maintenance",
      kind: "cron",
    },
    statusDescription: "keeps runtime projections caught up",
    title: "Projection upkeep",
    weights: { status: "hidden" },
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
      "23:45 UTC daily (end of the UTC day the snapshot is keyed on), with a retry slot at 23:57 UTC still inside that day. A bare trigger (the reach/anchor shape): fires the AGENT-tier record_catalogue_snapshot op once — the Worker computes every stage total + queue depth + frontier count through the SAME predicates the sweeps run (lib/server/funnel.ts) and UPSERTS one idempotent row per UTC day (a same-day re-run overwrites, never doubles a bar). A missed day cannot be recomputed later, so the tick is defended three ways: an in-tick retry ladder for a transient Worker fault, the second timer slot for a database-admission yield, and the Worker's catch-up grace window for a box that slept through the slot (it fills a missing previous day and names it as backfilledDays). Zero LLM tokens; the box's agent token drives it and calls the oRPC HTTP endpoint directly (no new CLI command the pinned box CLI would lack), so no new secret. Source: docs/agents/hermes/scripts/funnel-snapshot-sweep.*. See docs/admin-shell.md.",
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

const WEIGHT_ORDER: Record<SurfaceWeight, number> = {
  hidden: 3,
  primary: 0,
  secondary: 1,
  tertiary: 2,
};

export function liveSurfaces(): Surface[] {
  return SURFACES.filter((surface) => surface.pending !== true);
}

export function surfacesForContext(ctx: SurfaceContext): Surface[] {
  return liveSurfaces()
    .filter((surface) => surface.weights[ctx] !== undefined)
    .sort((a, b) => {
      const wa = a.weights[ctx];
      const wb = b.weights[ctx];

      return (wa ? WEIGHT_ORDER[wa] : 0) - (wb ? WEIGHT_ORDER[wb] : 0);
    });
}

export function surfacesByWeight(ctx: SurfaceContext, weight: SurfaceWeight): Surface[] {
  return liveSurfaces().filter((surface) => surface.weights[ctx] === weight);
}

export function surfacesByKind(kind: SurfaceKind): Surface[] {
  return liveSurfaces().filter((surface) => surface.kind === kind);
}

export function statusProbes(): Array<Surface & { probeConfig: ProbeConfig }> {
  return liveSurfaces().filter(
    (surface): surface is Surface & { probeConfig: ProbeConfig } =>
      surface.probeConfig !== undefined,
  );
}

export function cronSurfaces(): Surface[] {
  return surfacesByKind("cron");
}

export function runLedgerWriters(): RunLedgerWriter[] {
  const registered = cronSurfaces().flatMap((surface): RunLedgerWriter[] => {
    const probe = surface.probeConfig;

    if (
      probe?.kind !== "cron" ||
      probe.cronName === undefined ||
      probe.cronName === "fluncle-healthcheck" ||
      probe.cadenceMs === undefined
    ) {
      return [];
    }

    return [{ expectedIntervalMs: probe.cadenceMs, unit: probe.cronName }];
  });
  const direct: RunLedgerWriter[] = [
    { expectedIntervalMs: 3_600_000, unit: "fluncle-pin-watch" },
    { expectedIntervalMs: 900_000, unit: "fluncle-secrets-sync" },
    { expectedIntervalMs: 3_600_000, unit: "fluncle-sonar-freshen" },
    { expectedIntervalMs: 900_000, unit: "fluncle-timer-watchdog" },
  ];

  return [...registered, ...direct].sort((left, right) => left.unit.localeCompare(right.unit));
}
