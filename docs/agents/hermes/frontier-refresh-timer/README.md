# fluncle-frontier-refresh-timer — the paced Frontier playlist drain on a host timer

The rave-02 host trigger for the `--no-agent` **Frontier refresh** drain. E2, the public recommendation machine (docs/planning/ROADMAP.md § the public recommendation machine). Every verified user can mint ONE public **"Fluncle's Frontier"** playlist on Fluncle's OWN Spotify account (no per-user OAuth), holding THEIR recommendations — the E1 blend: the findings nearest their seeds first, then the anchored catalogue recs. This cron keeps each playlist current. The full design is [docs/the-ear.md](../../../the-ear.md) § Fluncle's Frontier.

## The model: a paced, resumable drain (every ~15 min)

The refresh was a Friday-07:00 BURST — it walked every minted playlist in one tick. At even a handful of users that hit Spotify's shared per-app rate limit (a ~30s rolling window shared by every Spotify path), 429-ing the very user paths it was meant to serve. So it is now a **paced drain**: every ~15 minutes the timer fires ONE `fluncle admin frontier refresh` (the `refresh_frontier_playlists` op), and the Worker processes only a small **batch of DUE users** — pending mints first, then users whose per-user cursor (`user_frontier_refresh`) is older than ~6 days. It full-replaces the playlists whose set changed (skipping the unchanged ones via a per-row URI-hash mirror guard), consults the shared Spotify budget and **stops cleanly when the window is spent** (`budgetPaused: true`, resumed next tick from the durable cursor), and stamps each user as it goes. The net effect is unchanged for the crew member — each playlist still refreshes ~weekly — but the work is SPREAD across the day instead of colliding in one overloaded pass. The batch size and the ~6-day due-gate live in the code (`FRONTIER_REFRESH_BATCH` / `FRONTIER_REFRESH_MIN_AGE_MS`), not the timer. The drain WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/frontier-refresh-sweep.sh`](../scripts/frontier-refresh-sweep.sh) → [`../scripts/frontier-refresh-sweep.ts`](../scripts/frontier-refresh-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Shipped DARK, so first activation is a deliberate operator act

The feature ships behind a **DEFAULT-DENY kill switch** (`frontier.minting` in the `settings` KV): ONLY the literal string `"true"` opens minting; an unset key, a fresh deploy, or a lost row reads as CLOSED. The switch gates only the EXTERNAL Spotify effect: with it closed the drain still performs its paced EDITION writes (the internal recommendation ledger the shelf reads — `switchOff: true`, editions written and reported as `editionOnly`), and skips only the Spotify mirror. So installing this timer is safe on any box: it never writes to Spotify until the operator opens minting, and its internal edition writes touch nothing a stranger can see.

- **It certifies nothing and creates no new public authority.** Every playlist it touches already exists, minted by its own owner. `refresh_frontier_playlists` is AGENT tier, so the box's existing agent-scoped token drives it — **no new secret**. Zero LLM tokens.
- **Best-effort per user.** One user's Spotify fault is counted in `failed` and the walk continues; the next week retries.

## The cover leg is separate (and operator-run)

The custom per-user playlist cover is a Remotion render — which does **not** run in a Worker — so it is NOT part of this sweep. It is a Node-side script, [`apps/web/scripts/render-frontier-covers.ts`](../../../../apps/web/scripts/render-frontier-covers.ts), that renders the cover (crew № stamped in a corner) and uploads it via the Worker's grant. That leg is **INERT** until the operator re-auths the Spotify grant with the `ugc-image-upload` scope: every upload degrades cleanly (`missing_scope`) and the row stays queued. Run it by hand after re-auth: `bun run --cwd apps/web scripts/render-frontier-covers.ts`.

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code (installed by [`../install-host-timers.sh`](../install-host-timers.sh), which auto-discovers every `*-timer/` dir). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-frontier-refresh`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper. `cron.frontier-refresh` is registered in `@fluncle/registry`, so it lights up `/status` the moment the timer runs.

## Install / operate (operator, on the box)

```bash
sudo bash /opt/hermes-scripts/../agents/hermes/install-host-timers.sh   # installs every *-timer/, incl. this one
systemctl list-timers 'fluncle-frontier-refresh*'                        # confirm the slot
sudo systemctl start fluncle-frontier-refresh.service                    # run one tick by hand
journalctl -u fluncle-frontier-refresh.service -n 50                     # read the JSON summary line
```
