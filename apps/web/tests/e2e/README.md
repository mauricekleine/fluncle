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
6. boots Vite; Playwright waits on `/api/health`

`globalTeardown` restores `.dev.vars` afterwards. A crashed run self-heals: the next boot restores from the backup it finds under the gitignored `.dev/`.

Two things are worth knowing before you change any of it. The dev worker runs under `@cloudflare/vite-plugin`, which injects `.dev.vars` as the worker's bindings and **ignores** process env — so the DB URL has to land in that file, which is why it is materialized before Vite starts. And Playwright starts its `webServer` **before** `globalSetup` (and the runner is Node, with no `Bun` globals), which is why the stack is built by the webServer command rather than a `globalSetup`.

## The seed

`seed.ts` holds a small, deterministic, committed dataset — invented titles and artists, no real IDs, no external media URLs. Local dev seeds from a prod snapshot (`.dev/seed.sql`, gitignored); that snapshot must never be committed and CI does not have it, so this suite seeds a fresh empty DB instead.

It currently contains 8 published findings (distinct titles, artists, and Log IDs, with descending `added_at`), 1 published mixtape, and one artist / label / album — with the first finding wired into the full artist ↔ label ↔ album graph.

Fixtures build on the `src/lib/server/integration-db.ts` factories (`seedTrack`, `seedArtist`, `seedLabel`, `seedAlbum`, `seedMixtape`, …) — the same ones the vitest integration suite uses, so fixture shapes cannot drift from the schema. Add a fixture there, not in a parallel helper.

## Adding a spec

Drop a `tests/e2e/<name>.spec.ts` (only `*.spec.ts` is collected; helpers alongside are ignored) and follow `home.spec.ts`, which is the reference shape:

- **Call `blockExternalRequests(page)` first** (`./browser`). It stubs every non-local request, so a spec never depends on — or hits — a live remote. It is load-bearing: some product URLs are hardcoded to the absolute prod host (a mixtape row's cover is derived from its Log ID via `mixtapeCoverUrl`) and would 404 against synthetic fixtures.
- **Assert on identity, not counts.** Import the seeded titles from `./seed` so the check does not rot as fixtures grow.
- **Check SSR separately from the rendered page.** `page.request.get(path)` returns the server HTML with no client JS — the crawler's view.
- **Gate on hydration with a state-safe retry.** Navigate with `waitUntil: "networkidle"` (this is a Vite dev server; the client bundle compiles on demand, so hydration lands seconds after `load`), then reset to a known state before each click attempt. A dropdown trigger toggles, so a naive click-and-check loop can alternate open/closed forever.
- **Fail on any console error or page error.** Attach the listeners before navigating and assert the collected list is empty. Do not add broad filters — the suite owns its whole environment, so an error is a real regression.

If a new spec needs data the seed does not carry, extend `seed.ts` (and, if a new table is involved, add the factory to `integration-db.ts`) rather than writing rows inline in the spec — the seed stays the single description of the world every spec shares.

## Adding an env var

If a new code path reads an env key on a public route, add a plainly-fake value of the right shape to `.dev.vars.e2e.tpl`. Never a real credential, hostname, or `op://` path — this repo is public, and a test run must not be able to reach anything real.
