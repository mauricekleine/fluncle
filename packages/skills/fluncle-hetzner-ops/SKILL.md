---
name: fluncle-hetzner-ops
description: "Operate Fluncle's Hetzner hosts: provision the public SSH terminal, deploy its systemd service, rotate its agent token, and rebuild the private Hermes box with its thin toolchain and 1Password CLI. Use for rave-01 SSH app hosting or the Fluncle-specific parts of rave-02 recovery."
---

# Fluncle Hetzner operations

Use the [canonical `mk-hetzner-devbox` skill](https://github.com/mauricekleine/dotfiles/blob/main/skills/mk-hetzner-devbox/SKILL.md) for generic Hetzner provisioning, prerequisites, and the Tailscale-only firewall. This skill owns Fluncle's host profiles and scripts. Read the private companion's host facts before acting; never put its addresses, vault paths, or credentials in this public repo. Creating a server, changing a firewall, deploying, or rotating a token requires the operator's authorization.

## Public SSH terminal (rave-01)

1. Follow the [`mk-hetzner-devbox` skill](https://github.com/mauricekleine/dotfiles/blob/main/skills/mk-hetzner-devbox/SKILL.md): run its `scripts/check-prereqs.sh` and `scripts/create-server.sh` with the server name and sizing from the private companion.
2. Bootstrap from a fresh root session with `REBOOT_STATUS_PORT=<private-port> SERVER_NAME=<name> SERVER_IPV4=<ip> packages/skills/fluncle-hetzner-ops/scripts/bootstrap-hardening.sh --profile public-ssh`. This streams `bootstrap-rave-vps.sh`: OpenSSH admin moves to port 2222 over Tailscale, TCP/22 is reserved for the Fluncle SSH app, and the app runs under a locked `fluncle-ssh` user. Confirm tailnet admin access before closing the root session. The public profile enables unattended security upgrades and schedules required reboots at 04:30 Europe/Amsterdam, with the host timezone set accordingly.
3. Apply the public provider firewall with `SERVER_NAME=<name> FIREWALL_PROFILE=public-ssh packages/skills/fluncle-hetzner-ops/scripts/apply-firewall.sh`. It allows ICMP, Tailscale UDP 41641, and app TCP/22. The generic private firewall does not open the app port.
4. Build the Go app as documented in [`README.md`](../../../README.md#ssh), then use `SERVER_NAME=<tailnet-address> BINARY_PATH=apps/ssh/dist/fluncle-ssh-linux-x64 packages/skills/fluncle-hetzner-ops/scripts/deploy-ssh-app-service.sh` for the initial service install or a service-contract change. Routine binary updates use [`apps/ssh/deploy/README.md`](../../../apps/ssh/deploy/README.md).

The public bootstrap installs an unprivileged `fluncle-reboot-status` service bound to the host's tailnet IPv4 on `REBOOT_STATUS_PORT`, chosen in private operator configuration. `GET /status` returns only `reboot_required_age_seconds` (null when no reboot is required), `kernel`, and `uptime_seconds`. It has no write routes or login capability. To update an existing host, transfer the adjacent `install-reboot-status.sh` and `reboot-status.py` together, then run the installer as root with that port. The private companion owns the fleet reader and single-port policy grant. For an authorized alert verification, `REBOOT_STATUS_MARKER` may point to an old private fixture under the service's `/run/fluncle-reboot-status` directory; restore `/var/run/reboot-required` after verification. The service reads that directory through a read-only mount.

For agent-token rotation, run `packages/skills/fluncle-hetzner-ops/scripts/push-agent-token.sh` from the trusted operator machine with `OP_AGENT_TOKEN_REF` set from the private companion. The script reads the value with `op`, pipes it over SSH, and verifies the watchdog and self-deploy status. `op` stays off the public edge.

The optional country display reads a MaxMind-compatible database at `/var/lib/fluncle-ssh/dbip-country-lite.mmdb` through `FLUNCLE_GEOIP_DB`. On the host, a monthly `fluncle-ssh-geoip-update.timer` refreshes DB-IP Lite via `/opt/fluncle-ssh/update-geoip-db.sh`; confirm the timer and keep DB-IP attribution in the SSH app's About screen. A new host needs the updater, timer, and `.mmdb` installed before enabling that environment setting.

## Private Hermes box (rave-02)

Follow [`fluncle-box-restore`](../fluncle-box-restore) for the ordered recovery and read-only preflight. Its Fluncle-specific host steps use `packages/skills/fluncle-hetzner-ops/scripts/bootstrap-hardening.sh --profile private`, which streams `bootstrap-private-vps.sh` and installs the 1Password CLI for host secret sync; `packages/skills/fluncle-hetzner-ops/scripts/apply-firewall.sh` with the private profile; and `TOOLCHAIN_PROFILE=agent-box packages/skills/fluncle-hetzner-ops/scripts/install-toolchain.sh`, which installs Docker and the small host floor without a workstation toolchain. Use the canonical `mk-hetzner-devbox` skill for generic prerequisites and server-creation steps. Use Tailscale SSH on port 22 as the login; OpenSSH on its configured alternate port stays as a key-only fallback. Verify Tailscale SSH access before attaching the private firewall.

Scripts read a skill-local `.env` when present, then the current directory's `.env`, or an explicit `ENV_FILE`. Keep real values out of this repo and its installed skill snapshot.
