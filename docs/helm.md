# Fluncle's Helm — the operator's mission control

The Helm is the operator's cockpit: one local app window per machine that gathers the operator jobs — raise the show, upload a recording, derive the cues, promote it, distribute it, watch the vitals — into one place instead of a scatter of terminals and remembered incantations. It is the human front-end to the work the `fluncle` CLI and `packages/live` already do; it runs those same commands for you, streams their output live, and taps you on the shoulder when it is time to record. The developer/contract reference (the daemon internals, the /api core, the feature-module contract) is [`apps/helm/README.md`](../apps/helm/README.md); this doc is the operator's map.

## What it is

A **LAN-local Bun daemon** (`apps/helm`, port **4190**) plus an **on-brand app window**, admin-authed. The daemon owns the machine identity, the run registry, macOS notifications, and the in-process admin bridge; the window is a React SPA on `@fluncle/ui` (Warm Dark, Phosphor icons, the CLI/admin voice register) that renders one panel per station.

It is **frame-agnostic**. v1 is a Chrome app-mode window (a chrome-less frame at `http://127.0.0.1:4190`); a native tray shim could wrap the same daemon later without the daemon ever knowing what frame it is in. The daemon is the product; the window is one way to look at it.

It is **local orchestration, not a Worker**. The Helm spawns processes on this Mac — the show, an upload, a Python cue script — and streams their stdout/stderr back to you. It never becomes a public endpoint and holds no place in the Galaxy's surface map (see [Not a Galaxy surface](#not-a-galaxy-surface)). It is the same class as the live glass: the operator's own machine, reachable by the operator alone.

## The two machines

Fluncle is run from two Macs, and the Helm shows each machine only the stations that belong on it — it reads `sysctl -n machdep.cpu.brand_string` at boot, resolves it to `m5 | m2 | unknown`, and gates every station's visibility on that. The split is the one from [AGENTS.md](../AGENTS.md#which-machine-am-i-on) and [docs/live-show-setup.md](./live-show-setup.md):

- **M5 — build/compose + capture/stream.** The show, the recording upload, promote, and distribute all live here, so the M5 Helm carries the pre-set and post-set stations plus the pulse.
- **M2 — mixing.** Rekordbox + the DDJ-FLX4 + `master.db`, and nothing else. The only Helm station on the M2 is the one that derives the cues from the Rekordbox history — the same discipline as the two `fluncle-mixtapes` scripts that are the M2's only sanctioned automation.
- **unknown** — a machine the brand string does not resolve is never locked out: it sees every station, and the badge says the machine is unknown so you know why.

## The stations — the flows it serves

Each station is a feature panel; the shell renders it only on the machines its manifest lists. `pulse-lite` ships in the shell itself as the end-to-end reference station; **show-control**, **set-lifecycle**, and **pulse** ship alongside it in the same train (they register against the shell's feature-module contract). Every long action runs as a daemon-spawned child, streamed to the window over SSE, with a **Stand down** button that SIGINTs it — so you watch the real command run, and you can stop it.

### Pre-set — pick a plan, raise the glass (M5)

Before you play, the **show-control** station is the pre-flight. Pick a plan by its galaxy-slug handle or its Log ID (plans are authored in the web editor at `/admin/plans`), and raise the show — the Helm runs `bun run --cwd packages/live show --plan <handle|logId>` (with `--force`, `--audio-index`, `--display-index` as needed) and streams it. The show's pre-flight is a parseable vocabulary — `[clear]` / `[hold]` / `[dark]` tokens from `packages/live/src/show.ts` — so the station renders them as a live checklist of status rows rather than as raw log spew: you see at a glance what has cleared and what is still holding. The Helm **spawns** the show; it never serves the glass (`:4173`) or the bridge (`:4180`) — those are `packages/live`'s ports, and the Helm stays off them by construction. The full rig, cabling, and dress-rehearsal gate are in [docs/live-show-setup.md](./live-show-setup.md).

### Post-set — upload, cues, promote, distribute

After the set, the **set-lifecycle** station walks the recording from a raw capture to a distributed mixtape. It is the two-machine chain:

1. **Upload the recording (M5).** `fluncle admin recordings create --video <file> --title … --recorded-at …` sends the master to R2. This is a multi-GB transfer, and it runs local-direct under the daemon — the operator's own process class — so the load-bearing "large uploads run on the M5, operator-direct" rule from AGENTS.md is satisfied by construction rather than by remembering it.
2. **Derive the cues (M2).** On the mixing machine, the station runs the Rekordbox cue scripts (`packages/skills/fluncle-mixtapes/scripts/rekordbox-derive-cues.py` and `rekordbox-plan-export.py`, uv/Python over `master.db`) to turn the set's history into an ordered, timed tracklist. This station only appears on the M2, because `master.db` only lives there.
3. **Promote the recording → a mixtape (M5).** `fluncle admin recordings promote` mints the mixtape from the recording. A mixtape is born only by promotion — there is no draft-mixtape path — so this is the moment the coordinate-less recording becomes a spine-native, `F`-marked mixtape.
4. **Distribute (M5).** `fluncle admin mixtapes distribute …` fans the mixtape out to YouTube (video) and Mixcloud (audio), streamed so you watch each leg land.

The doctrine, the exact per-mixtape runbook, and the spine model behind promote/distribute are the [fluncle-mixtapes](../packages/skills/fluncle-mixtapes) skill; the Helm is the cockpit that runs its steps in order without you leaving the window.

### The pulse and the nudge

The **pulse** station is the always-on vitals board: which machine you are on, the daemon's own health, the recent runs, and the live [/status](https://www.fluncle.com/status) picture of the Galaxy's services. It also holds the **nudge** — a server-side reminder (roughly the 18-hour cadence) delivered as a macOS notification via `osascript`. Because the nudge lives in the daemon, not the window, it fires even when no window is open — the daemon under launchd taps you on the shoulder to record the next set. `pulse-lite`, the reference station shipped in the shell, already implements the whole loop in miniature: a vitals read, a test notification, and a streamed line-check that proves the SSE round-trip end to end.

## Running it

The launcher is the `fluncle helm` command group (hidden from the public CLI help, like `admin`, since it is operator-only):

```bash
fluncle helm            # start-or-focus: raise the daemon if it is down, then open the window
fluncle helm install    # install the LaunchAgent — the daemon rises at login
fluncle helm uninstall  # stand the agent down and remove it
```

`fluncle helm` is **start-or-focus**: if the daemon already answers on `:4190` it just opens the window; otherwise it builds the glass once if needed, boots the daemon detached (logs to `~/Library/Logs/fluncle-helm.log`), waits for health, and opens the window. It opens a Chrome app-mode window when Chrome is present and falls back to the default browser otherwise.

`fluncle helm install` writes a `com.fluncle.helm` LaunchAgent (RunAtLoad, crash-restart on a non-clean exit), so the daemon rises at login and holds the port windowless — which is what lets the nudge fire without anyone opening the window. `uninstall` boots the agent out and removes the plist. Both are macOS-only (launchd), and both are safe to re-run.

Running from a repo checkout, the launcher finds `apps/helm` by walking up from the CLI; running the standalone binary outside the repo, point it at the checkout with `FLUNCLE_HELM_DIR=<path>/apps/helm`. Day-to-day development of the Helm itself uses the workspace scripts (`bun run --cwd apps/helm dev|build|start|test`) documented in [`apps/helm/README.md`](../apps/helm/README.md).

## Ports, LAN mode, and the phone

The daemon binds `127.0.0.1:4190` by default — reachable only from the machine it runs on. Set `FLUNCLE_HELM_LAN=1` to bind the LAN/tailnet instead (the `packages/live` precedent), which is the **phone companion path**: with the daemon on the LAN, a phone on the same network can open the same window and drive the same stations — the run drawer and its Stand-down button in your pocket while your hands are on the decks. `FLUNCLE_HELM_PORT` overrides the port. Ports `4173` and `4180` are never touched — they belong to the live glass and bridge, which the Helm spawns but never serves.

## Security posture

The Helm is **localhost by default** — the safe binding — and only opens to the LAN when you explicitly ask with `FLUNCLE_HELM_LAN=1`, and then only on a trusted show network.

The admin credentials stay **server-side**. The daemon loads the CLI's stored admin token in-process (it imports the CLI's own env + API modules) and makes every authenticated call itself; the token never travels to the window and never appears in a feature panel. A panel calls its own `/api/<id>/…` route on the daemon, and the daemon's feature server makes the admin call on its behalf. The window is a view; the daemon is the only thing that holds a secret. `/api/health` reports whether the admin token is aboard without ever revealing it.

Feature runs are scoped to their station: one station can never stream or kill another's child process, and every child is stood down when the daemon exits.

## Not a Galaxy surface

The Helm is **not** registered in [`@fluncle/registry`](../packages/registry/src/index.ts), and this is deliberate. That catalog inventories the reach of Fluncle's tentacles across the web — the public and operator-known surfaces reachable across the Galaxy — and it is explicitly not a route table or an infra inventory. The Helm is the opposite of reach: a per-machine, localhost-bound operator cockpit. It also fits none of the registry's four display contexts (`web` / `ssh` / `cli` / `status`) — it is not a web page, not in the rave terminal, not publicly probeable by `/status` (localhost, per-machine), and its `fluncle helm` launcher is an operator-only verb.

This follows a precedent that is already canon: the live glass and its phone remote (`packages/live`, on `:4173` / `:4180`) are LAN-local operator surfaces that [surfaces-doctrine §1](./surfaces-doctrine.md) keeps out of the registry by design, registering the `run_show` orchestrator that raises them as a **local-exec op** in [naming-conventions §7](./naming-conventions.md#7-local-exec-ops-the-registrys-non-http-tail) instead. The Helm's launch is the same category — a local orchestration that drives processes on the operator's own machine and never calls the Worker — so the Helm belongs with `run_show`, outside `@fluncle/registry`, not on the `/status` board or any context menu.

## Troubleshooting

- **The window won't open / the daemon won't answer.** `fluncle helm` waits ~15s for `/api/health` before giving up with the log path. The daemon's log is at `~/Library/Logs/fluncle-helm.log` — the detached boot and the launchd agent both write there. Check it first.
- **Is it up?** `curl -s http://127.0.0.1:4190/api/health` returns `{ ok, machine, pid, port, startedAt, uptimeMs, adminTokenAboard }`. `adminTokenAboard: false` means the daemon booted but found no CLI admin credentials — the authenticated stations will fail until the CLI's admin token is in place (see [Environment in the README](../README.md#environment)).
- **The wrong stations are showing.** The station set is gated on the resolved machine — `curl -s http://127.0.0.1:4190/api/machine` shows the brand string and the `m5 | m2 | unknown` it resolved to. An `unknown` machine sees every station on purpose.
- **A run is stuck.** Every streamed action has a Stand-down button (SIGINT, then SIGKILL after a grace); `GET /api/runs` lists what the registry knows. Restarting the daemon stands every child down.
- **The launcher can't find the helm.** Outside the repo checkout, set `FLUNCLE_HELM_DIR` to the `apps/helm` directory.
