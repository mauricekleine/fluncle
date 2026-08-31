# Public-flow E2E (`@playwright/test`)

Browser tests for Fluncle's **public** surfaces, run against a fully isolated throwaway stack. Distinct from `tests/browser/` — those are hand-rolled operator smokes that drive a live dev server as the admin; this suite owns its own stack and its own data.

```bash
bun run --cwd apps/web test:e2e:install   # once: fetch the bundled chromium
bun run --cwd apps/web test:e2e           # boot the stack, run the suite, tear it down
bun run --cwd apps/web test:e2e:report    # open the HTML report from the last run
```

It is deliberately NOT wired into `bun run test` — `turbo run test` runs inside the Cloudflare deploy gate, where no browser exists.

Needs the `turso` CLI **and** `sqld` on PATH: `turso dev` is only a launcher and execs `sqld` separately, so a machine with just the CLI fails at boot with _"Could not start libsql-server … make sure sqld is on your PATH"_. A dev Mac gets both from Homebrew (`turso`, `sqld`); CI installs both from pinned release tarballs.

## What the stack is

One Bun orchestrator, `scripts/e2e-stack.ts`, is Playwright's `webServer`. It builds everything in order, then runs Vite in the foreground:

1. refuses to start if either dedicated port is taken — Vite **:3140**, libSQL **:9440** (chosen to collide with nothing: not dev `:3000`, not the smoke routine `:3120`/`:8899`, not the per-worktree libSQL range `:8100–:8999`)
2. materializes the committed `.dev.vars.e2e.tpl` (all-fake values) into `.dev.vars`, backing up a real one
3. boots `turso dev` over a **fresh empty** db file
4. runs `db:migrate` — the real generated migrations plus the FTS5 index
5. applies the synthetic seed (`seed.ts`)
6. boots Vite; Playwright waits on `/api/v1/health`

`globalSetup` then warms the dev server (see below), and `globalTeardown` restores `.dev.vars` afterwards. A crashed run self-heals: the next boot restores from the backup it finds under the gitignored `.dev/`.

**The warm-up matters.** This is a dev server, so it pre-bundles dependencies on demand. On a cold cache it can discover one _while already serving the page_, re-optimize, and answer the in-flight module requests with `504 (Outdated Optimize Dep)` — the client entry then fails to import and the page never hydrates. It self-heals on the next load, so `globalSetup` absorbs it with throwaway loads until one comes back clean. That is what lets every spec keep a strict fail-on-any-console-error gate with no filters. The race is timing-dependent and does not reproduce on a fast machine even with the cache deleted; it showed up first on CI.

Two things are worth knowing before you change any of it. The dev worker runs under `@cloudflare/vite-plugin`, which injects `.dev.vars` as the worker's bindings and **ignores** process env — so the DB URL has to land in that file, which is why it is materialized before Vite starts. And Playwright starts its `webServer` **before** `globalSetup` (and the runner is Node, with no `Bun` globals), which is why the stack is built by the webServer command rather than a `globalSetup`.

## The seed

`seed.ts` holds a small, deterministic, committed dataset — invented titles and artists, no real IDs, no external media URLs. Local dev seeds from a prod snapshot (`.dev/seed.sql`, gitignored); that snapshot must never be committed and CI does not have it, so this suite seeds a fresh empty DB instead.

It currently contains 8 published findings (distinct titles, artists, and Log IDs, with descending `added_at`), 1 published mixtape, and one artist / label / albums — with the first finding wired into the full artist ↔ label ↔ album graph. A handful of those rows carry the extras the FRONT DOOR needs and nothing else provides: an operator note (so the edited lead is provably the noted finding rather than the newest), cover art (so the "one eager image, everything else lazy" contract has rows to measure), and release dates. Beside them sits one UNCERTIFIED catalogue track — a `tracks` row with no `findings` row — so the release band can be seen rendering both registers without either being named. Three more uncertified rows carry the ARCHIVE TRACK DESTINATION's world (`track.spec.ts`): an evidence-rich one (a record, a release date, a cover, and two outbound services — the indexed half of the evidence gate), an evidence-rich NEIGHBOUR for the journey to continue into, and a thin one (a name and nothing else — the `noindex` half). All three carry MuQ embeddings, because "close in sound" is a vector scan and without vectors the band correctly renders nothing. Plus one further finding that satisfies the `/radio` ELIGIBILITY predicate (a square master, an observation, its length, a Log ID), which nothing else does, so the radio loop has exactly one thing it can ever resolve to.

Fixtures build on the `src/lib/server/integration-db.ts` factories (`seedTrack`, `seedArtist`, `seedLabel`, `seedAlbum`, `seedMixtape`, …) — the same ones the vitest integration suite uses, so fixture shapes cannot drift from the schema. Add a fixture there, not in a parallel helper.

## Adding a spec

Drop a `tests/e2e/<name>.spec.ts` (only `*.spec.ts` is collected; helpers alongside are ignored) and follow `findings.spec.ts`, which is the reference shape:

- **Call `blockExternalRequests(page)` first** (`./browser`). It stubs every non-local request, so a spec never depends on — or hits — a live remote. It is load-bearing: some product URLs are hardcoded to the absolute prod host (a mixtape row's cover is derived from its Log ID via `mixtapeCoverUrl`) and would 404 against synthetic fixtures.
- **Assert on identity, not counts.** Import the seeded titles from `./seed` so the check does not rot as fixtures grow.
- **Check SSR separately from the rendered page.** `page.request.get(path)` returns the server HTML with no client JS — the crawler's view.
- **Gate on hydration with a state-safe retry.** Navigate with `waitUntil: "networkidle"` (this is a Vite dev server; the client bundle compiles on demand, so hydration lands seconds after `load`), then reset to a known state before each click attempt. A dropdown trigger toggles, so a naive click-and-check loop can alternate open/closed forever.
- **Fail on any console error or page error.** Attach the listeners before navigating and assert the collected list is empty. Do not add broad filters — the suite owns its whole environment, so an error is a real regression.

If a new spec needs data the seed does not carry, extend `seed.ts` (and, if a new table is involved, add the factory to `integration-db.ts`) rather than writing rows inline in the spec — the seed stays the single description of the world every spec shares.

## The front door's scroll evidence

`front-door.spec.ts` writes a full-page screenshot per width — `desktop-1440x900.png` and `mobile-390x844.png` — into the gitignored `apps/web/.dev/front-door/`. They are evidence that `/` reads as one long deliberate scroll at both widths, and the assertions in that spec (every band visible with height, bands ordered down the page, `scrollHeight` past one viewport, no horizontal bleed) are what actually gate it; the images are for a human to look at.

Regenerate them at any commit with:

```bash
bun run --cwd apps/web test:e2e -- tests/e2e/front-door.spec.ts
FRONT_DOOR_SHOT_DIR=/tmp/shots bun run --cwd apps/web test:e2e -- tests/e2e/front-door.spec.ts   # elsewhere
```

They are not committed, and that is the deliberate trade: this repo is public, a pair of full-page PNGs is several megabytes of binary that git keeps forever, and a committed screenshot goes stale the moment a style moves — which turns evidence into a stale claim. The durable home is the CI artifact instead. `.github/workflows/e2e.yml` uploads `front-door-scroll` on every run, green or red, so each commit's evidence is retained for 90 days (GitHub's ceiling on a public repo) and downloadable from its own check without a byte entering history.

## The cold-arrival journey's evidence

`track.spec.ts` writes a full-page screenshot per STEP per width into the gitignored `apps/web/.dev/track-journey/` — `<width>-1-arrive.png`, `-2-neighbour.png`, `-3-leave.png` at both 1440×900 and 390×844. They are evidence that a stranger can land on an archive track, continue into an unfamiliar sonic neighbour, and leave to an accurate outbound listening service, with no account, at both widths. The assertions in that spec are what actually gate it; the images are for a human to look at.

Regenerate them at any commit with:

```bash
bun run --cwd apps/web test:e2e -- tests/e2e/track.spec.ts
TRACK_JOURNEY_SHOT_DIR=/tmp/shots bun run --cwd apps/web test:e2e -- tests/e2e/track.spec.ts   # elsewhere
```

Same trade as the front door's scroll evidence, for the same reasons: never committed, uploaded by `.github/workflows/e2e.yml` as the always-on `track-journey` artifact, retained 90 days per commit.

## The search surface's viewport evidence

`search.spec.ts` does the same for `/search`, into the gitignored `apps/web/.dev/search/`: `desktop-1440x900.png` and `mobile-390x844.png` answering a query, plus `mobile-390x844-zero.png` for the zero state (the first thing a stranger sees). Same terms as the front door's — the assertions in the spec are what gate it, the images are for a human, and `.github/workflows/e2e.yml` uploads them as the always-on `search-surface` artifact rather than committing binaries to a public repo.

```bash
bun run --cwd apps/web test:e2e -- tests/e2e/search.spec.ts
SEARCH_SHOT_DIR=/tmp/shots bun run --cwd apps/web test:e2e -- tests/e2e/search.spec.ts   # elsewhere
```

## The tier-4 rail: no OpenRouter key, on purpose

`.dev.vars.e2e.tpl` deliberately carries NO `OPENROUTER_API_KEY`, and that absence is a rail rather than an omission. A FAKE key is worse than none: `translateQuery` only short-circuits on "unprovisioned", so a key of any shape makes search's fourth tier issue a real request to openrouter.ai **from the Worker** — which `blockExternalRequests` cannot see, because it stubs the browser's requests and never the server's. With the key absent, tier 4 returns `null` immediately and the resolver degrades to full text, which is the documented degradation contract (`docs/search.md`) and the local-dev steady state. Search still answers, deterministically, and nothing leaves the machine — which is what makes a natural-language query testable here at all rather than something specs have to route around.

## Adding an env var

If a new code path reads an env key on a public route, add a plainly-fake value of the right shape to `.dev.vars.e2e.tpl`. Never a real credential, hostname, or `op://` path — this repo is public, and a test run must not be able to reach anything real.
