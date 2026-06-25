# fluncle-pin-watch — the box self-deploy

The rave-02 (Hermes box) half of the version-currency loop. The [`fluncle-maintenance`](../../../../packages/skills/fluncle-maintenance) routine sweeps the pinned supply chain, opens a clearly-safe bump as a PR, and merges it on green — and then **stops**. This is what closes the loop: a small host systemd timer on rave-02 that watches `main` and, when a baked CLI pin moves ahead of what the running container has, rebuilds the Hermes image and swaps the container — with a pre-smoke gate and an auto-rollback rail.

This is the **pull model**: the repo is canonical, the box is the deploy target, and the box deploys _itself_ — the same self-heal shape the box already uses for enrich / observe / the render conductor. It means the maintenance routine never needs SSH, `op`, or box access, so it can run anywhere (Claude Desktop today, the cloud tomorrow).

## Why it's a host timer, not a Hermes cron

A container can't cleanly rebuild and replace _itself_. The rebuild has to run on the **host** (which owns the Docker daemon), so this is a systemd timer on the rave-02 host — the same pattern as the rave-01 [`fluncle-rave-watchdog`](../../../../apps/ssh/watchdog). The Hermes-container crons (enrich/observe/render) do _app_ work; this does _infra_ work.

## Credential-free by design

It puts **no token on the box** and reads nothing from `op`:

- **Build context:** the Fluncle repo is public, so the clone at `/opt/fluncle-build` needs no key.
- **Secrets:** the new container reuses the **running container's own runtime env**, captured via `docker inspect` (the container's env minus the image's baked `ENV` = the `--env-file` vars). That capture lives only in a `tmpfs` file for the duration of the swap; nothing is written to host disk persistently, and no secret is ever read from `op`. (The values are already on the box — they were `op read` into the container's env at the last operator deploy.)

The one credential the box does NOT hold is the op service-account token, on purpose: the box never needs to _read_ a secret, only to _carry forward_ the ones it already runs with. (If a future need arises to rotate secrets on the box, that's the only thing that would want a read-only, scoped service token — see the maintenance skill's note.)

## What a run does (`rebuild-hermes.sh`)

Default `--if-stale` (the timer); `--force` runs it unconditionally (the operator pilot).

1. **Single-flight** (flock) — never two rebuilds at once.
2. **Sync** the public repo into `/opt/fluncle-build` (clone or fetch + hard-reset to `origin/main`).
3. **Compare pins:** the `fluncle@` + `@anthropic-ai/claude-code@` versions in `docs/agents/hermes/Dockerfile` vs the running container's `fluncle version` / `claude --version`. Current → **no-op**. The base image (`FROM`) is _not_ watched — a base bump stays a manual operator brake.
4. **Capture** the running container's runtime env into a `0600` tmpfs file (the rollback-reversibility step) + record the current image as the rollback target.
5. **Build** the new image (`fluncle-hermes:v<date>-<sha>`), repo-root context, `-f docs/agents/hermes/Dockerfile`.
6. **Pre-smoke the NEW image in throwaway `--rm` containers — before the live one is touched:** `fluncle version` == the pin; `claude --version` == the pin; an agent-token read returns `{ok:true}`; a publish-class command is **refused** (role boundary intact). Any failure → abort, alert, **the live box is never touched**.
7. **Swap** (the only moment the live container changes): stop+rm, `docker run` the new image with the captured env + the canonical `§ Run` flags.
8. **Post-swap smoke:** the gateway is `Running` and `fluncle` answers.
9. **On any post-swap failure → ROLLBACK:** restore the previous image, confirm it's up, alert loudly. If the rollback itself fails, fire the loudest alert and stop for a human. **The box is never left broken.**

Discord alerts (deploy / rollback / failure) use the `DISCORD_ALERT_WEBHOOK` already in the container's env — no config file.

## Deploy (on rave-02, one time)

```bash
# 1. Drop the script (0755) at its deployed path.
sudo install -D -m 0755 docs/agents/hermes/pin-watch/rebuild-hermes.sh \
  /opt/fluncle-pin-watch/rebuild-hermes.sh

# 2. Clear any accumulated debt + validate the recipe end to end (the pilot).
sudo /opt/fluncle-pin-watch/rebuild-hermes.sh --force

# 3. Install the timer.
sudo install -m 0644 docs/agents/hermes/pin-watch/pin-watch.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/pin-watch/pin-watch.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pin-watch.timer

# Verify.
sudo systemctl start pin-watch.service     # one --if-stale run now
journalctl -u pin-watch.service -n 40 --no-pager
systemctl list-timers pin-watch.timer
```

The script is idempotent and a no-op when current, so the timer is safe to run as often as you like.
