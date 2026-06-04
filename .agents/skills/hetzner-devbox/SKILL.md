---
name: hetzner-devbox
description: "Provision and harden Hetzner Cloud Ubuntu VPS profiles for AI-agent private devboxes and public SSH app servers. Use when creating or verifying a Tailscale-only devbox, a public Wish/Bubble Tea SSH terminal such as ssh rave.fluncle.com, provider firewalls, systemd services, or remote development toolchains."
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
skills/hetzner-devbox/scripts/check-prereqs.sh
```

2. Create or reuse the server:

```sh
skills/hetzner-devbox/scripts/create-server.sh
```

Set `SERVER_NAME`, `SERVER_TYPE`, `LOCATION`, `IMAGE`, or `HCLOUD_SSH_KEY_NAME` to override defaults. The script prints the public IPv4 address needed for the first root SSH bootstrap.

3. Run the remote hardening bootstrap:

```sh
SERVER_IPV4=<public-ip> skills/hetzner-devbox/scripts/bootstrap-hardening.sh
```

This streams the vendored `scripts/bootstrap-private-vps.sh` over SSH, passes `TS_AUTHKEY` without putting the key on the command line, and configures the server as Tailscale-only. After it finishes, verify `ssh admin@<tailscale-hostname>` works before relying on the firewall.

4. Apply the Hetzner provider firewall:

```sh
skills/hetzner-devbox/scripts/apply-firewall.sh
```

The provider firewall allows only inbound ICMP and UDP `41641` for Tailscale direct WireGuard connections. It deliberately does not allow public TCP/SSH. Host UFW remains the stricter inner layer.

5. Install the devbox toolchain:

```sh
skills/hetzner-devbox/scripts/install-toolchain.sh
```

This installs base packages, Docker Engine plus Compose, GitHub CLI, Bun, `uv`, current Node LTS user-locally, Codex CLI, and Claude Code by default. Set `INSTALL_*` flags to `0` to opt out of optional groups. Set `INSTALL_REMOTION_LIBS=1` to include headless Chromium runtime libraries.

## Public SSH App Workflow

Use this for `ssh rave.fluncle.com`-style services. Prefer a dedicated small VPS. Do not expose normal OpenSSH on public TCP/22.

1. Create the server with public-app naming:

```sh
SERVER_NAME=fluncle-rave-01 SERVER_TYPE=cx22 skills/hetzner-devbox/scripts/create-server.sh
```

2. Bootstrap the host for a public SSH app:

```sh
SERVER_NAME=fluncle-rave-01 SERVER_IPV4=<public-ip> TS_HOSTNAME=fluncle-rave-01 \
  skills/hetzner-devbox/scripts/bootstrap-hardening.sh --profile public-ssh
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
SERVER_NAME=fluncle-rave-01 FIREWALL_PROFILE=public-ssh \
  skills/hetzner-devbox/scripts/apply-firewall.sh
```

This allows only ICMP, UDP `41641`, and public TCP `22` at the provider layer.

4. Deploy the built SSH app binary:

```sh
SERVER_NAME=fluncle-rave-01 BINARY_PATH=./apps/ssh-rave/dist/fluncle-ssh \
  FLUNCLE_API_URL=https://www.fluncle.com \
  skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh
```

The service runs as `fluncle-ssh`, binds TCP/22 with `CAP_NET_BIND_SERVICE`, and keeps writable state confined to `/var/lib/fluncle-ssh`.

## Verification

After setup, verify from a fresh local shell:

```sh
ssh admin@agent-devbox-01 'bash -lc "id -nG; docker ps; bun --version; uv --version; node --version; gh --version | head -n 1; codex --version; claude --version"'
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

## Safety Rules

- Never print `.env` values or auth keys.
- Never materialize private SSH keys; rely on the user's local SSH agent.
- Do not delete existing Hetzner servers, firewalls, or SSH keys unless the user explicitly asks.
- If a server was created in the same run and bootstrap fails, explain the state and ask before deleting it.
- Treat adding `admin` to the Docker group as root-equivalent access and mention that tradeoff when relevant.
- Ask before creating paid infrastructure when running this skill from an agent session.
- Keep public SSH app servers minimal. Do not install Docker, Codex, Claude, or general dev tooling unless the user explicitly asks.
- Public repositories must not contain Hetzner tokens, Tailscale auth keys, private SSH keys, production API tokens, or host-specific secrets.
