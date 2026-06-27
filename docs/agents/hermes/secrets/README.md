# Hermes box secrets — single source from 1Password

Every secret the rave-02 Hermes box uses comes from ONE place: the **`Fluncle Automations`** 1Password vault (a dedicated, least-privilege vault — the box's service account is scoped read-only to it and nothing else). A host `op`-sync materializes them into two files; nothing is hand-edited. Concrete vault/item names and the operator runbook live in the private **"Fluncle — Ops Runbook"** 1Password note — this directory carries the mechanism and `.example` templates only (public repo).

## The flow

- `/etc/hermes-bootstrap.env` (host, `0600 root:root`, **not** in git) — the `op` service-account token (`OP_SERVICE_ACCOUNT_TOKEN`), scoped read-only to `Fluncle Automations`. The one irreducible bootstrap secret: it can't come from `op` (it's what authenticates `op`), so it's placed by hand and rotated by hand. Everything else flows from it.
- `fluncle-secrets-sync.{sh,service,timer}` — a host systemd timer (at boot + every 15 min) that sources the bootstrap token and runs `op inject` on the two templates, writing (atomically, sanity-checked):
  - `/etc/hermes.env` — the **gateway** env-file (the container's `--env-file` at start): `OPENROUTER_API_KEY`, `DISCORD_*`, `FLUNCLE_API_TOKEN`. No Claude token — the gateway authenticates its model via OpenRouter.
  - `/opt/data/home/.fluncle-secrets.env` (the mounted state dir the container sees) — the **`--no-agent` sweep** secrets: `CLAUDE_CODE_OAUTH_TOKEN`, `DISCORD_ALERT_WEBHOOK`, `BOX_API_KEY`. Sourced by `note-sweep` / `observe-sweep` / `render-conductor` at run time, so a rotation is picked up live (no restart). The render conductor scp's the Claude token onward to the scale-to-zero rave-03 render box's `/dev/shm` (unchanged).

Two consumers, two files, one source. The `--no-agent` sweeps can't read provider creds from the cron env (the GHSA-rhgp-j443-p4rf strip), which is why their secrets live in a file the sync writes — never in the env.

## Rotate a secret

Update it in the `Fluncle Automations` vault. The timer re-injects within ~15 min; the sweeps pick it up on their next tick. Gateway-env secrets take effect on the next container restart.

## Templates

`*.tpl.example` here are placeholders (`op://<automations-vault>/<ITEM>/credential`). The real templates (concrete `Fluncle Automations` refs) live on the box at `/etc/hermes/*.tpl` and are recorded in the "Fluncle — Ops Runbook" 1P note.

## Follow-up (designed, not yet applied)

Move `.fluncle-secrets.env` to **tmpfs** (`/run/fluncle`, bind-mounted read-only into the container) so the Claude token is never on persistent disk — mirroring the rave-03 `/dev/shm` pattern. Needs a container re-run (the new mount) plus the pin-watch `run_container` change (`--env-file /etc/hermes.env` + the mount). Do it on a deliberate restart window.
