---
name: hetzner-devbox
description: "Provision, harden, deploy, and verify Hetzner Cloud Ubuntu VPS profiles for AI-agent private devboxes and public SSH app servers. Use when creating or operating a Tailscale-only devbox, deploying a public Wish/Bubble Tea SSH terminal such as ssh rave.fluncle.com, configuring provider firewalls, systemd services, GeoIP database refresh, or remote development toolchains."
---

# Hetzner Devbox

Use this skill to create hardened Hetzner Cloud Ubuntu VPS profiles:

- **private devbox**: Tailscale-only admin/development machine.
- **public SSH app server**: public TCP/22 terminates a purpose-built SSH app such as a Wish/Bubble Tea TUI, while OpenSSH admin access stays private over Tailscale.

It is an opinionated starting point, not a universal cloud provisioning framework.

## Defaults

- Server name: `agent-devbox-01`
- Server type: `cpx32`
- Location: `nbg1`
- Image: `ubuntu-24.04`
- Admin user: `admin`
- Private firewall name: `agent-devbox-private`
- Public SSH app firewall name: `fluncle-rave-public`
- Tailscale hostname: server name
- Bun version: `1.2.15`

## Required Local State

- `hcloud`, `jq`, `ssh`, `ssh-add`, and `git` must be available locally.
- `HCLOUD_TOKEN` and a fresh `TS_AUTHKEY` must be set in the environment or in `.env`.
- `HCLOUD_SSH_KEY_NAME` must be set before creating a new server.
- The Hetzner SSH private key must already be loaded into the local SSH agent. Never export, copy, paste, or write private SSH keys to disk.

The scripts load `.env` from the skill directory by default, or from the current working directory if no skill-local `.env` exists. Override with `ENV_FILE=/path/to/.env`.

Use `scripts/check-prereqs.sh` before provisioning. It checks commands, required environment values, and loaded SSH-agent identities without printing secret values.

## Private Devbox Workflow

1. Check prerequisites:

```sh
packages/skills/hetzner-devbox/scripts/check-prereqs.sh
```

2. Create or reuse the server:

```sh
packages/skills/hetzner-devbox/scripts/create-server.sh
```

Set `SERVER_NAME`, `SERVER_TYPE`, `LOCATION`, `IMAGE`, or `HCLOUD_SSH_KEY_NAME` to override defaults. The script prints the public IPv4 address needed for the first root SSH bootstrap.

3. Run the remote hardening bootstrap:

```sh
SERVER_IPV4=<public-ip> packages/skills/hetzner-devbox/scripts/bootstrap-hardening.sh
```

This streams the vendored `scripts/bootstrap-private-vps.sh` over SSH, passes `TS_AUTHKEY` without putting the key on the command line, and configures the server as Tailscale-only. Admin access is **plain OpenSSH on `:2222`** reached over the tailnet (tunneled through WireGuard/UDP `41641`), **not** Tailscale SSH on `:22`. Tailscale SSH (`--ssh`) is deliberately NOT used: on a tailnet whose ACL sets the SSH `action` to `"check"`, it forces a per-session browser re-auth that blocks every headless/agent connection — plain sshd avoids it, and key-only auth + tailnet membership remain the two factors (no public exposure either way). After it finishes, verify `ssh -p 2222 admin@<tailscale-hostname>` works before relying on the firewall. **Disable Tailscale key expiry for the node** (admin console → Machines → ⋯ → Disable key expiry), or pass `TS_TAGS=tag:server` so the node joins tag-owned and is exempt from expiry — a private box has no public fallback, so an expired key is a total lockout.

4. Apply the Hetzner provider firewall:

```sh
packages/skills/hetzner-devbox/scripts/apply-firewall.sh
```

The provider firewall allows only inbound ICMP and UDP `41641` for Tailscale direct WireGuard connections. It deliberately does not allow public TCP/SSH. Host UFW remains the stricter inner layer.

5. Install the devbox toolchain:

```sh
packages/skills/hetzner-devbox/scripts/install-toolchain.sh
```

This installs base packages, Docker Engine plus Compose, GitHub CLI, Bun, `uv`, current Node LTS user-locally, Codex CLI, and Claude Code by default. Set `INSTALL_*` flags to `0` to opt out of optional groups. Set `INSTALL_REMOTION_LIBS=1` to include headless Chromium runtime libraries.

## Public SSH App Workflow

Use this for `ssh rave.fluncle.com`-style services. Prefer a dedicated small VPS. Do not expose normal OpenSSH on public TCP/22.

1. Create the server with public-app naming:

```sh
SERVER_NAME=<server-name> SERVER_TYPE=cx23 packages/skills/hetzner-devbox/scripts/create-server.sh
```

2. Bootstrap the host for a public SSH app:

```sh
SERVER_NAME=<server-name> SERVER_IPV4=<public-ip> TS_HOSTNAME=<server-name> \
  packages/skills/hetzner-devbox/scripts/bootstrap-hardening.sh --profile public-ssh
```

This streams `scripts/bootstrap-rave-vps.sh` to root. It:

- creates the `admin` user for private administration;
- installs and joins Tailscale;
- moves OpenSSH to port `2222`;
- disables password and root SSH login;
- creates a locked `fluncle-ssh` user with `/usr/sbin/nologin`;
- prepares `/opt/fluncle-ssh` and `/var/lib/fluncle-ssh`;
- grants UFW public TCP/22 for the app and Tailscale-only admin access.

3. Apply the public SSH app Hetzner firewall:

```sh
SERVER_NAME=<server-name> FIREWALL_PROFILE=public-ssh \
  packages/skills/hetzner-devbox/scripts/apply-firewall.sh
```

This allows only ICMP, UDP `41641`, and public TCP `22` at the provider layer.

4. Deploy the built SSH app binary:

```sh
SERVER_NAME=<server-name> BINARY_PATH=./apps/ssh/dist/fluncle-ssh-linux-x64 \
  FLUNCLE_API_URL=https://www.fluncle.com \
  packages/skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh
```

The service runs as `fluncle-ssh`, binds TCP/22 with `CAP_NET_BIND_SERVICE`, and keeps writable state confined to `/var/lib/fluncle-ssh`.

For Fluncle's repo-native SSH app, build and deploy manually:

```sh
GOOS=linux GOARCH=amd64 go build -C apps/ssh -o dist/fluncle-ssh-linux-x64 .

SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" \
SERVER_NAME=<tailscale-ip> \
BINARY_PATH=apps/ssh/dist/fluncle-ssh-linux-x64 \
FLUNCLE_API_URL=https://www.fluncle.com \
FLUNCLE_GEOIP_DB=/var/lib/fluncle-ssh/dbip-country-lite.mmdb \
packages/skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh
```

The deploy script uploads the binary, writes `/etc/fluncle-ssh.env`, installs `/etc/systemd/system/fluncle-ssh.service`, reloads systemd, restarts `fluncle-ssh`, and prints service status. Remove local `apps/ssh/dist/` artifacts before committing; the repo ignores `apps/*/dist/`.

`deploy-ssh-app-service.sh` is now the **bootstrap only** (first install / the service contract). Ongoing updates self-deploy — see below.

### Self-deploy (fluncle-ssh-freshen)

After bootstrap, the SSH terminal keeps itself current **credential-free** via `apps/ssh/deploy/fluncle-ssh-freshen` — a host systemd timer on rave-01 that watches `main` and, when a commit changes `apps/ssh`'s compiled sources (`*.go`, `go.mod`, `go.sum` — e.g. a `golang.org/x/crypto` CVE bump), rebuilds the binary **on the box**, pre-smokes it in isolation (boot on a throwaway port + a real SSH key-exchange), swaps it into `fluncle-ssh`, restarts, post-smokes, and auto-rolls-back on any failure. It only replaces the binary (the unit + `/etc/fluncle-ssh.env` are untouched) and reads nothing from `op`; the SSH sibling of the rave-02 [`pin-watch`](../../../docs/agents/hermes/pin-watch), beside the rave-01 [`watchdog`](../../../apps/ssh/watchdog) (which only observes — the two never fight). Full doctrine + the run flow: [`apps/ssh/deploy/README.md`](../../../apps/ssh/deploy/README.md).

**One-time operator setup on rave-01** (irreducible steps — an agent cannot run these; they need the box):

1. **Install the Go toolchain** (the one provisioning pre-req; rave-01 is otherwise toolchain-free). Match the `go` version in `apps/ssh/go.mod` — currently **1.26**, which is newer than the distro `golang-go`, so use the **official tarball**, not apt: `curl -fsSLO "https://go.dev/dl/$(curl -fsSL https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz"`, `sudo tar -C /usr/local -xzf go*.linux-amd64.tar.gz`, then symlink it **onto systemd's default PATH** so the unit finds it: `sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go`.
2. **Drop the script** at its deployed path: `sudo install -D -m 0755 apps/ssh/deploy/fluncle-ssh-freshen.sh /opt/fluncle-ssh-freshen/fluncle-ssh-freshen.sh`.
3. **(Optional, for the Discord alert + `self-deploy-ssh` `/status` row) point `/etc/fluncle/ssh-freshen.env` at the watchdog's env** rather than duplicating the token: `sudo ln -s rave-watchdog.env /etc/fluncle/ssh-freshen.env`. Both units read `DISCORD_ALERT_WEBHOOK` + `FLUNCLE_API_TOKEN` from that one file, so a single token refresh (see [Rotate the agent token](#rotate-the-agent-token)) heals the watchdog **and** the self-deploy posts. Skip the symlink and the self-deploy still runs, just without that visibility.
4. **Pilot attended:** `sudo /opt/fluncle-ssh-freshen/fluncle-ssh-freshen.sh --force` (clears debt + validates the recipe end to end). `--dry-run` builds + pre-smokes without touching the live service.
5. **Install + enable the timer:** `sudo install -m 0644 apps/ssh/deploy/fluncle-ssh-freshen.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now fluncle-ssh-freshen.timer`.

### Rotate the agent token

rave-01 is the **public-access** edge, so it deliberately holds **no `op` / 1Password service account** — a credential there would put the vault keys on the most-exposed box. The trade-off: its agent token (in `/etc/fluncle/rave-watchdog.env`, read by the watchdog **and**, via the step-3 symlink, the self-deploy) is placed by hand, so an agent-token rotation does **not** auto-reach it and drifts silently (a stale token 401s every `record_health` post — the `onion` and `self-deploy-ssh` `/status` rows go stale).

Close that as the **last step of a rotation** with `scripts/push-agent-token.sh` — it reads the new token with `op` **on the trusted machine** (the Mac or rave-02) and pipes it over SSH into rave-01's env in place. The value travels `op → pipe → box file`: never printed, never on a command line. `op` stays off the edge.

```sh
OP_AGENT_TOKEN_REF='op://<vault>/FLUNCLE_AGENT_TOKEN/credential' \
  packages/skills/hetzner-devbox/scripts/push-agent-token.sh
```

The concrete `op://` ref lives in the private ops runbook note (never committed). The script patches only the `FLUNCLE_API_TOKEN` line (0600 root, every other line preserved), then restarts the watchdog + self-deploy and confirms both `/status` rows post `ok` (pass `--no-verify` to skip that check). Add this line to the agent-token rotation recipe in the ops note.

### Optional GeoIP Country Codes

`fluncle-ssh` can show deduplicated country codes for connected sessions when `FLUNCLE_GEOIP_DB` points at a MaxMind-compatible `.mmdb`. Unknown, private, local, or failed lookups render as `VOID`.

For the production rave server, DB-IP Lite is installed outside the repo:

- Database: `/var/lib/fluncle-ssh/dbip-country-lite.mmdb`
- Updater: `/opt/fluncle-ssh/update-geoip-db.sh`
- Timer: `fluncle-ssh-geoip-update.timer`
- Service env: `FLUNCLE_GEOIP_DB=/var/lib/fluncle-ssh/dbip-country-lite.mmdb`

Install or refresh the DB-IP Lite setup with an admin Tailscale SSH session:

```sh
ssh -p 2222 admin@<tailscale-ip> 'sudo /opt/fluncle-ssh/update-geoip-db.sh && sudo systemctl restart fluncle-ssh'
```

If provisioning from scratch, create the updater and timer on the host, download `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz`, decompress it to `/var/lib/fluncle-ssh/dbip-country-lite.mmdb`, and set owner/group to `fluncle-ssh:fluncle-ssh` with mode `0640`. DB-IP requires attribution when used; keep the SSH app's About screen attribution intact.

## Verification

After setup, verify from a fresh local shell:

```sh
ssh -p 2222 admin@agent-devbox-01 'bash -lc "id -nG; docker ps; bun --version; uv --version; node --version; gh --version | head -n 1; codex --version; claude --version"'
```

Also verify:

- `hcloud firewall describe agent-devbox-private` shows only ICMP and UDP `41641` inbound.
- `sudo ufw status verbose` on the server shows inbound allowed on `tailscale0` and no public SSH allow rule.
- `admin` is in the `docker` group on a fresh login if Docker was installed.

For public SSH app servers, verify:

- `hcloud firewall describe fluncle-rave-public` shows only ICMP, UDP `41641`, and TCP `22` inbound.
- `ssh -p 2222 admin@<tailscale-hostname>` works over Tailscale.
- `ssh rave.fluncle.com` opens the app, not a shell.
- `ssh rave.fluncle.com whoami` is rejected by the app.
- `sudo ss -tulpn` shows the SSH app on `:22` and OpenSSH on `:2222`.
- `sudo systemctl status fluncle-ssh` is healthy.
- `sudo cat /etc/fluncle-ssh.env` has the expected API and optional GeoIP paths, without secrets.
- `systemctl list-timers --all fluncle-ssh-geoip-update.timer --no-pager` shows a scheduled monthly refresh when GeoIP is enabled.

## Safety Rules

- Never print `.env` values or auth keys.
- Never materialize private SSH keys; rely on the user's local SSH agent.
- Do not delete existing Hetzner servers, firewalls, or SSH keys unless the user explicitly asks.
- If a server was created in the same run and bootstrap fails, explain the state and ask before deleting it.
- Treat adding `admin` to the Docker group as root-equivalent access and mention that tradeoff when relevant.
- Ask before creating paid infrastructure when running this skill from an agent session.
- Keep public SSH app servers minimal. Do not install Docker, Codex, Claude, or general dev tooling unless the user explicitly asks.
- Public repositories must not contain Hetzner tokens, Tailscale auth keys, private SSH keys, production API tokens, or host-specific secrets.
