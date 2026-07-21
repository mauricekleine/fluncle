# fluncle-ssh-freshen — the SSH terminal's self-deploy

The rave-01 half of the SSH terminal's version-currency loop. Until now `apps/ssh` (the public `ssh rave.fluncle.com` terminal) was deployed **by hand**: an operator cross-built the Go binary on a Mac and `scp`'d it up with [`deploy-ssh-app-service.sh`](../../../packages/skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh). So a merge to `main` — a `golang.org/x/crypto` CVE bump included — did **not** reach the live server until someone remembered to redeploy. This closes that gap: a small host systemd timer on rave-01 that watches `main` and, when a commit changes the SSH app's compiled sources, rebuilds the binary **on the box**, pre-smokes it in isolation, swaps it into the `fluncle-ssh` service, and auto-rolls-back on any failure.

This is the **pull model** — the repo is canonical, the box is the deploy target, and the box deploys _itself_ — the SSH sibling of the rave-02 Hermes self-deploy in [`docs/agents/hermes/pin-watch`](../../../docs/agents/hermes/pin-watch). It lives beside the rave-01 dead-man's-switch [`watchdog`](../watchdog) (which only _observes_ — it never touches the binary or the service, so the two never fight): `watchdog/` is monitoring, `deploy/` is self-deploy, both host-systemd surfaces under `apps/ssh`.

## Why a host timer (not a container / not the app itself)

The `fluncle-ssh` service can't cleanly rebuild and replace _its own_ running binary. The rebuild + swap has to run as a separate host process — a `Type=oneshot` systemd timer on the rave-01 host — exactly like [`pin-watch`](../../../docs/agents/hermes/pin-watch) on rave-02 and the [`fluncle-rave-watchdog`](../watchdog) beside it.

## Credential-free by design

It puts **no token on the box** for its core job and reads nothing from `op`:

- **Build context:** the Fluncle repo is public, so the clone at `/opt/fluncle-ssh-build` needs no key.
- **The swap only replaces the binary.** It writes `/opt/fluncle-ssh/fluncle-ssh` and restarts the service; the systemd unit and `/etc/fluncle-ssh.env` (the service contract the deploy script established) are **left untouched**, so the reused runtime env is exactly what the operator already placed. Nothing is captured, nothing is read from `op`.

The only optional inputs — the Discord webhook and the agent-scoped API token used for the best-effort **alert** + **/status** visibility — come from an operator-placed `EnvironmentFile` (`/etc/fluncle/ssh-freshen.env`, `-`-optional in the unit) kept **out of the repo**. Unset any of them and that visibility is simply skipped; the self-deploy still runs. (The token is the same agent-scoped token the [watchdog](../watchdog) already uses for its `record_health` POST — you can point this at the same values.)

## Build model: on-box `go build` (and why, vs a CI-built artifact)

The binary is compiled **on rave-01** with `go build`, mirroring pin-watch and the render box (both build on-box). The alternative — have CI cross-build a linux artifact and have the box pull it — was considered and **not** taken: it would add a whole second moving part (a GitHub Actions release/rolling-tag scheme + a checksum-trust step + a box-side download/verify) for the sole benefit of keeping the Go toolchain off the edge box. On-box build keeps the loop **fully self-contained, credential-free, and single-artifact**, consistent with the rest of the fleet, and the pre-smoke-before-swap + auto-rollback safety is identical either way.

The one cost is the trade-off to know: rave-01 is the deliberately-minimal public edge (the hetzner-devbox skill says _don't_ pile dev tooling onto it). The Go toolchain is the single concession — but it is qualitatively lighter than the Docker/agent runtimes that warning targets: a static compiler with **no daemon, no listener, no background process**, dormant except for the ~10s of an actual freshen tick, building into a throwaway dir the running service never touches. **Installing Go is the one irreducible provisioning pre-req** (see the deploy steps).

## What a run does (`fluncle-ssh-freshen.sh`)

Default `--if-changed` (the timer); `--force` rebuilds unconditionally (the operator pilot); `--dry-run` builds + pre-smokes then stops (never swaps).

1. **Single-flight** (flock) — never two runs at once.
2. **Sync** the public repo into `/opt/fluncle-ssh-build` (clone or fetch + hard-reset to `origin/main`). Full history (not shallow) so the change-detection diff can reach the last-deployed commit.
3. **Decide whether to rebuild.** Compare the recorded deployed SHA (`/opt/fluncle-ssh-freshen/deployed-sha`) to `HEAD`. Rebuild when `--force`, on the first run (no baseline), if the baseline is unreachable (history rewrite → safe re-baseline), or when `git diff <deployed>..HEAD -- apps/ssh` touches a **compiled source** (`*.go`, `go.mod`, `go.sum`). A docs-only, unit-only (`apps/ssh/deploy`, `apps/ssh/watchdog`, `*.md`), or web-only merge changes no compiled source → **no rebuild, no restart**.
4. **Build** the new binary on-box (`CGO_ENABLED=0 go build`) into a throwaway dir.
5. **Pre-smoke the NEW binary in ISOLATION — before the live service is touched:** boot it on a free loopback port + temp data dir (no GeoIP), then prove it completes a real **SSH key exchange** (`ssh-keyscan` returns the freshly-generated host key). This is the exact failure a bad crypto/wish bump would cause — the server not speaking SSH — caught with the live service untouched. A boot-then-handshake smoke needs no network (the app only calls the API per-session, not at boot). Any failure → abort, alert, **the live service is never touched**.
6. **Swap** (the only moment the live service changes): snapshot the current binary to `fluncle-ssh.prev` (the rollback target), atomically rename the new binary into place, `systemctl restart fluncle-ssh`. Replacing the on-disk file under the running process is safe on Linux (the old process holds its inode until the restart). The restart briefly drops active SSH sessions — the same momentary blip the manual `deploy-ssh-app-service.sh` restart causes today.
7. **Post-swap smoke:** the service is `active` **and** the live port completes an SSH key exchange. On success, record the new SHA and drop the `.prev` snapshot.
8. **On any post-swap failure → ROLLBACK:** restore `fluncle-ssh.prev`, restart, confirm healthy, alert loudly. If the rollback itself fails, fire the loudest alert and stop for a human. **The box is never left broken.**

Discord alerts (deploy / rollback / failure) use `DISCORD_ALERT_WEBHOOK` from the optional env file. Every run also reports a **`self-deploy-ssh`** health check to the public [`/status`](https://www.fluncle.com/status) board (POST `/api/v1/admin/health`, agent tier) — the rave-01 parallel to pin-watch's `self-deploy` row — so this loop is visible alongside the rest: `ok` when current or freshly deployed, `degraded` when a build/pre-smoke failed or a swap was rolled back (service healthy on the prior binary, a human should look), `down` if a rollback itself failed. Both the alert and the status post are best-effort and public-safe (no host, no raw error); if the timer ever stops, the `/status` row simply goes stale — itself the signal that the terminal may be silently drifting.

## Deploy (on rave-01, one time)

> **Pre-req — the Go toolchain.** rave-01 is the minimal public edge, so Go is not there by default. Install it once (the app targets the `go` version in [`apps/ssh/go.mod`](../go.mod)); e.g. via the distro package (`sudo apt-get install -y golang-go`) or the official tarball to `/usr/local/go` with `/usr/local/go/bin` on `PATH` for the unit. This is the single irreducible operator pre-req. The initial binary is still bootstrapped by [`deploy-ssh-app-service.sh`](../../../packages/skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh) (which also creates the `fluncle-ssh` user/service, `/opt/fluncle-ssh`, and `/etc/fluncle-ssh.env`); the freshen takes over every update after that.

```bash
# 1. Drop the script (0755) at its deployed path (sibling to the other box binaries).
sudo install -D -m 0755 apps/ssh/deploy/fluncle-ssh-freshen.sh \
  /opt/fluncle-ssh-freshen/fluncle-ssh-freshen.sh

# 2. (Optional) Place the 0600 operator env file for the Discord alert + /status post.
#    Keys: DISCORD_ALERT_WEBHOOK, FLUNCLE_API_TOKEN (values in the ops runbook note in
#    1Password — the same pair the watchdog uses). Skip this and the self-deploy still
#    runs, just without Discord/status visibility.
sudo install -d -m 0755 /etc/fluncle
sudo install -m 0600 /dev/null /etc/fluncle/ssh-freshen.env
sudo "$EDITOR" /etc/fluncle/ssh-freshen.env

# 3. Clear any accumulated debt + validate the recipe end to end (the attended pilot).
sudo /opt/fluncle-ssh-freshen/fluncle-ssh-freshen.sh --force

# 4. Install the units, reload, enable + start the timer.
sudo install -m 0644 apps/ssh/deploy/fluncle-ssh-freshen.service /etc/systemd/system/
sudo install -m 0644 apps/ssh/deploy/fluncle-ssh-freshen.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-ssh-freshen.timer

# Verify.
sudo systemctl start fluncle-ssh-freshen.service     # one --if-changed run now
journalctl -u fluncle-ssh-freshen.service -n 40 --no-pager
systemctl list-timers fluncle-ssh-freshen.timer
```

Preview without touching the live service any time with `sudo /opt/fluncle-ssh-freshen/fluncle-ssh-freshen.sh --dry-run` (builds + pre-smokes the current `main`, then stops). The script is idempotent and a no-op when current, so the timer is safe to run as often as you like.

## The service contract it must match

The swap targets exactly what [`deploy-ssh-app-service.sh`](../../../packages/skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh) establishes: the binary at `/opt/fluncle-ssh/fluncle-ssh`, the `fluncle-ssh` systemd service, and `/etc/fluncle-ssh.env` (`FLUNCLE_API_URL`, `FLUNCLE_SSH_HOST/PORT/DATA_DIR/GEOIP_DB`). It reads `FLUNCLE_SSH_PORT` from that env for the post-swap handshake smoke (default `22`). All of these are overridable via `SSHFRESHEN_*` env vars for a non-standard layout, but the defaults are the canonical deploy paths.
