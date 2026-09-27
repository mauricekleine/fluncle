---
name: hetzner-devbox
description: "Provision, harden, and verify a personal Hetzner Cloud Ubuntu VPS devbox that is reachable only over Tailscale. Use when creating a locked-down private devbox or agent VPS, applying the Tailscale-only Hetzner firewall, running the remote hardening bootstrap, or installing the remote development toolchain (Docker, Bun, uv, Node, Codex, Claude Code)."
---

# Hetzner Devbox

Use this skill to create a hardened, long-running personal devbox on Hetzner Cloud: an Ubuntu VPS that joins a Tailscale tailnet and is reachable **only** over it. It is an opinionated starting point, not a universal cloud provisioning framework.

This is the generic core. Projects that need extras (public SSH app servers, deploy pipelines, token push) keep those in their own overlay skills — see [Project overlays](#project-overlays).

## Security Posture

The box ends up with **zero publicly reachable TCP ports**, enforced at two independent layers:

1. **Hetzner provider firewall** (outer layer): inbound allows only ICMP (diagnostics) and UDP `41641` (Tailscale direct WireGuard). No public TCP at all — deliberately no public SSH.
2. **Host UFW** (inner, stricter layer): default deny incoming, allow outgoing, allow inbound only on the `tailscale0` interface. Even if the provider firewall is detached, nothing public answers.

Hardening applied by the bootstrap (`scripts/bootstrap-private-vps.sh`, streamed over the first and only public root SSH session):

- Non-root `admin` user (sudo NOPASSWD), root's `authorized_keys` copied over.
- OpenSSH moved to port `2222`, key-only: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`.
- Ubuntu 23.04+ socket activation (`ssh.socket`) is explicitly disabled — otherwise the `Port` directive is silently ignored, sshd stays on `:22`, and the Tailscale-only firewall leaves no way in.
- Tailscale joined with `--accept-dns`, **without** `--ssh`. Admin access is plain OpenSSH on `:2222` tunneled through WireGuard (UDP `41641`), not Tailscale SSH: on a tailnet whose ACL sets the SSH `action` to `"check"`, Tailscale SSH forces a per-session browser re-auth that blocks every headless/agent connection. Key-only auth + tailnet membership remain the two factors; nothing is publicly exposed either way.

**Key expiry**: a private box has no public fallback, so an expired Tailscale node key is a total lockout. Either pass `TS_TAGS=tag:server` so the node joins tag-owned (tag-owned nodes are exempt from key expiry; requires the auth key + ACL `tagOwners` to permit the tag), or disable key expiry manually (admin console → Machines → ⋯ → Disable key expiry) right after bootstrap.

## Defaults

- Server name: `devbox-01`
- Server type: `cpx32`
- Server purpose: `devbox` (applied as a Hetzner label)
- Location: `nbg1`
- Image: `ubuntu-24.04`
- Admin user: `admin`
- Admin SSH port: `2222`
- Firewall name: `devbox-private`
- Tailscale hostname: server name
- Bun version: `1.4.2`

All are overridable via environment variables of the same spirit (`SERVER_NAME`, `SERVER_TYPE`, `SERVER_PURPOSE`, `LOCATION`, `IMAGE`, `USERNAME`, `ADMIN_SSH_PORT`, `FIREWALL_NAME`, `TS_HOSTNAME`, `BUN_VERSION`).

## Prerequisites and Required Environment

Local commands: `hcloud`, `jq`, `ssh`, `ssh-add`, `git`.

Required values (in the environment or `.env`):

- `HCLOUD_TOKEN` — Hetzner Cloud API token for the target project (this is the env var the `hcloud` CLI reads; create it in the Hetzner Cloud console under Security → API tokens).
- `TS_AUTHKEY` — a **fresh** Tailscale auth key for the bootstrap join. It is a short-lived one-time bootstrap credential; do not store it in a password manager, mint a new one per provision.
- `HCLOUD_SSH_KEY_NAME` — the name of the SSH key already uploaded to the Hetzner project, required when creating a new server.

Optional: `TS_TAGS` (e.g. `tag:server`) for tag-owned, expiry-exempt nodes.

The Hetzner SSH private key must already be loaded into the local SSH agent. Never export, copy, paste, or write private SSH keys to disk.

The scripts load `.env` from the skill directory by default, or from the current working directory if no skill-local `.env` exists. Override with `ENV_FILE=/path/to/.env`. See `.env.example`.

Use `scripts/check-prereqs.sh` before provisioning. It checks commands, required environment values, and loaded SSH-agent identities without printing secret values.

## Workflow

1. Check prerequisites:

```sh
scripts/check-prereqs.sh
```

2. Create or reuse the server:

```sh
scripts/create-server.sh
```

Set `SERVER_NAME`, `SERVER_TYPE`, `LOCATION`, `IMAGE`, or `HCLOUD_SSH_KEY_NAME` to override defaults. The script is idempotent (reuses an existing server by name) and prints the public IPv4 address needed for the first root SSH bootstrap.

3. Run the remote hardening bootstrap:

```sh
SERVER_IPV4=<public-ip> scripts/bootstrap-hardening.sh
```

This streams the vendored `scripts/bootstrap-private-vps.sh` over SSH to root, passing `TS_AUTHKEY` via stdin-prepended exports so the key never appears on a command line. If `SERVER_IPV4` is unset it is looked up via `hcloud`. After it finishes, verify `ssh -p 2222 admin@<tailscale-hostname>` works **before** relying on the firewall, and handle key expiry (see [Security Posture](#security-posture)).

4. Apply the Hetzner provider firewall:

```sh
scripts/apply-firewall.sh
```

Idempotent: creates the firewall if missing, adds only the ICMP and UDP `41641` rules if absent, and attaches it to the server. It deliberately does not allow public TCP/SSH.

5. Install the devbox toolchain (over the tailnet, via `admin@<server-name>:2222`):

```sh
scripts/install-toolchain.sh
```

Installs base packages, Docker Engine plus Compose, GitHub CLI, Bun, `uv`, current Node LTS user-locally, Codex CLI, and Claude Code by default. Set `INSTALL_DOCKER`, `INSTALL_GH`, `INSTALL_BUN`, `INSTALL_UV`, `INSTALL_NODE_LTS`, `INSTALL_CODEX`, or `INSTALL_CLAUDE` to `0` to opt out of groups. Set `INSTALL_REMOTION_LIBS=1` to include headless Chromium runtime libraries (`libnspr4`, `libnss3`). It leaves `gh`, `codex`, and `claude` authentication to the user.

6. Optional: after authenticating `gh` on the box, clone your repos into `~/src` and use `tmux` for long-running sessions.

## Verification

From a fresh local shell:

```sh
ssh -p 2222 admin@devbox-01 'bash -lc "id -nG; docker ps; bun --version; uv --version; node --version; gh --version | head -n 1; codex --version; claude --version"'
```

Also verify:

- `hcloud firewall describe devbox-private` shows only ICMP and UDP `41641` inbound.
- `sudo ufw status verbose` on the server shows inbound allowed on `tailscale0` only, and no public SSH allow rule.
- `sudo ss -tulpn` shows sshd on `:2222` only (nothing on `:22`).
- `admin` is in the `docker` group on a fresh login if Docker was installed.
- Tailscale key expiry is disabled for the node (or the node is tag-owned).

## Project Overlays

This skill owns the generic devbox: provision + harden + toolchain. Project-specific extensions live in the project's own skill and layer on top; they are deliberately **not** part of this core. Typical overlay patterns:

- a `bootstrap-<host>.sh` public-app host profile (public TCP/22 terminating an SSH app, fail2ban, locked `nologin` app user).
- a `deploy-<app>-service.sh` that uploads the app binary and installs the hardened systemd unit.
- a `push-agent-token.sh` that pushes a rotated API token from a trusted `op` machine onto the credential-free edge box.

If a project needs a public port, a service user, or a deploy pipeline, copy this pattern: keep this skill's scripts untouched and add the extras in a `<project>-…` overlay skill in that repo.

## Safety Rules

- Never print `.env` values, `HCLOUD_TOKEN`, or Tailscale auth keys.
- Never materialize private SSH keys; rely on the user's local SSH agent.
- Do not delete existing Hetzner servers, firewalls, or SSH keys unless the user explicitly asks.
- If a server was created in the same run and bootstrap fails, explain the state and ask before deleting it.
- Treat adding `admin` to the Docker group as root-equivalent access and mention that tradeoff when relevant.
- Ask before creating paid infrastructure when running this skill from an agent session.
- Never commit Hetzner tokens, Tailscale auth keys, private SSH keys, or host-specific secrets.
