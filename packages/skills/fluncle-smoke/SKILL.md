---
name: fluncle-smoke
description: >-
  Smoke-test that Fluncle's surfaces still RESOLVE after a refactor, route/contract
  change, or deploy — the route-resolution layer that complements /status
  service-health. Use after deleting or moving HTTP routes / oRPC contracts / registry
  surfaces, after a big merge, before trusting a deploy, or when asked to "smoke test",
  "probe the surfaces", "check nothing broke", "did the refactor break anything",
  "verify everything still works across surfaces". Derives its target list LIVE from
  @fluncle/registry + @fluncle/contracts each run so it never drifts, and flexes to
  probe recently-changed + undocumented surfaces. This is an agent-run cross-surface
  sweep — deliberately a skill, not a public `fluncle` CLI command, and distinct from
  /status (which is service health, not route resolution).
---

# Fluncle surface smoke

Confirm every surface still answers at the right tier after a change. This is route/surface **RESOLUTION** ("does the endpoint exist and answer correctly?") — the complement to `/status` + `fluncle status`, which cover service **HEALTH** (web / r2 / dns / ssh / crons / render-box / hermes up?). Together they're full coverage; this one catches the class a service probe sails past — a deleted or moved route returning `404` (the #227 dormant-file-route cleanup was exactly this risk).

It is a skill, not a command, on purpose: surfaces shift, and judging each result (regression vs. POST-only op vs. expected-by-design) needs reasoning a frozen script can't carry. Half the job is interpretation — see **Judgment** below.

## Anti-drift: derive the target list every run, never hardcode

Read the current sources of truth so shifted surfaces are covered automatically and a stale list can't lie:

- **oRPC routes** — `packages/contracts/src/orpc/**`: every op's `path` + `method` + tier. The exhaustive route list. Enumerate with `rg -n 'path:' packages/contracts/src/orpc`.
- **Surfaces** — `@fluncle/registry` (`packages/registry/src/index.ts`, `liveSurfaces()`): web routes, feeds, subdomains, api, discovery, mcp, ssh, dns, cli, cron. The add-a-surface map is the [fluncle-surfaces](../fluncle-surfaces) skill + [`docs/surfaces-doctrine.md`](../../docs/surfaces-doctrine.md).
- **What just moved** — `git diff --stat <last-deploy>..HEAD -- apps/web/src/routes packages/contracts packages/registry` to focus the sweep on the change and to catch surfaces not yet (or never) in the registry.

## Target

Default prod `https://www.fluncle.com`. For a pre-merge PR, smoke its Cloudflare **branch preview** first — the CF build posts a deployment URL shaped `https://<branch>-fluncle-web.<acct>.workers.dev` (find it via `gh pr view <n> --json comments`). Verifying the preview before merge is how you catch a route regression without shipping it.

## The sweep

1. **oRPC route resolution (the big one).** For every contract op, `curl -X <method> <target><path>` and assert **served, never 404**: public-tier → `200`; admin/private-tier unauthenticated → `401`. A `404` means the route is dead = regression. A `405`/`400` means served (wrong method/body) = fine.
2. **Public web + feeds + discovery.** Each registry web-route / feed / discovery surface → `200`: `/`, `/log`, `/log/<logId>`, `/mixtapes`, `/status`, `/galaxy`, `/earth`, `/pipeline`, `/about`, `/docs/api`; `/rss.xml`, `/atom.xml`, `/podcast.xml`, `/sitemap.xml`, `/llms.txt`, `/robots.txt`, `/cli/latest.sh`, `/api/v1/openapi.json`, `/api/v1/postman.json`.
3. **Subdomains.** `galaxy.`, `radio.`, `status.` → `200`. `found.` is the R2 object store — its **root 404s by design**; probe a real object (`found.fluncle.com/<logId>/set.mp4` → `200`).
4. **CLI.** Dry-run the thin client's read paths against the target: `bun run --cwd apps/cli fluncle recent --limit 1 --json`, `fluncle tracks get <logId> --json`, `fluncle status`. Confirms the CLI→API contract end to end.
5. **MCP / SSH / DNS.** MCP at `/mcp` (GET `405` / POST `400` = served). SSH terminal `rave.fluncle.com:22` TCP-open (`bash -c 'cat </dev/null >/dev/tcp/rave.fluncle.com/22'`). DNS `dig +short @rave.fluncle.com <name> TXT`.
6. **/api/status aggregate.** The box's own view: `services` all `ok`, `secondsSinceFreshestReport` small (the host-timer healthcheck is fresh).
7. **Interactive surfaces — only when the change touched them.** The video players and admin UI need a real browser past hydration, not a `200`. Drive the chrome-devtools MCP (logged-out: the public `/log/<mixtape>` player) or claude-in-chrome (the authed admin): verify playback / seek / overlay / the actual interaction. See the `verify-interactive-states-visually` memory.

## Judgment (what a frozen script gets wrong)

- **Method matters.** POST-only ops (`backfill`, `mixtape youtube`, `mixcloud/token`) return `404` to a GET — probe each op with its real method or you raise false alarms.
- **`401` on admin is healthy** (served + auth-gated); `404` is dead. Never read `401` as a failure.
- **og vs cover.** `/api/og/<id>` is findings-only; mixtapes use `/api/mixtape-cover/<id>`. A mixtape logId correctly `404`s on `/api/og`.
- **CLI commands are plural + canonical** (`tracks get`, not the retired `track` alias). A removed alias failing with `unknown command` is a pass, not a break.
- **`record_health` POSTs abort transiently during a Worker redeploy** — a `/status` blip right after a merge is the deploy settling, not an outage; re-check after ~1 minute.
- **Auth-gated UI can't be probed headless** — the admin API returning `401` is the proxy signal; flag the UI itself as eyeball-only.
- oRPC is mounted ahead of TanStack in `server.ts`, so a path owned by a contract op is served by oRPC even where a file-route once lived — the basis for the "never 404" assertion (the oRPC-default principle lives in `AGENTS.md` Architecture).

## Report

A pass/fail table grouped by surface kind, leading with any `404` / unexpected status as the investigate list. Resolve each anomaly to "regression" or "expected (which gotcha)" before calling it clean — an unexplained `404` is never a pass. The service-health side is the `fluncle-monitoring-stack-live` memory; the oRPC carve-out map is `orpc-migration-complete`.
