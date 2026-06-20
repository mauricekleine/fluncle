#!/usr/bin/env bash
set -Eeuo pipefail

USERNAME="${USERNAME:-admin}"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"
# Admin reaches this box with plain OpenSSH on this port over the tailnet
# (ssh -p ${ADMIN_SSH_PORT} admin@<tailscale-ip>). We deliberately do NOT use
# Tailscale SSH (--ssh): it intercepts :22 and, on a tailnet whose ACL sets the
# SSH action to "check", forces a per-session browser re-auth that blocks every
# headless/agent connection. Plain sshd on a non-22 port tunnels through
# WireGuard (UDP 41641, the one firewall-open port) and is never intercepted —
# the same admin path the rave box already uses.
ADMIN_SSH_PORT="${ADMIN_SSH_PORT:-2222}"
# Optional ACL tag (e.g. tag:server). Tag-owned nodes are exempt from Tailscale
# key expiry by construction — the durable fix for "no public fallback = key
# expiry is total lockout". Needs the auth key + ACL tagOwners to permit the tag;
# if left unset, disable key expiry manually in the Tailscale admin.
TS_TAGS="${TS_TAGS:-}"

if [[ "${EUID}" -ne 0 ]]; then
  printf 'bootstrap-private-vps.sh must run as root\n' >&2
  exit 1
fi

if [[ -z "${TS_AUTHKEY:-}" ]]; then
  printf 'TS_AUTHKEY is required\n' >&2
  exit 1
fi

log() {
  printf '\n==> %s\n' "$*"
}

log "Installing base hardening packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg sudo ufw openssh-server

log "Creating admin user ${USERNAME}"
if ! id "${USERNAME}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups sudo "${USERNAME}"
fi

install -d -m 0700 -o "${USERNAME}" -g "${USERNAME}" "/home/${USERNAME}/.ssh"
if [[ -f /root/.ssh/authorized_keys ]]; then
  install -m 0600 -o "${USERNAME}" -g "${USERNAME}" /root/.ssh/authorized_keys "/home/${USERNAME}/.ssh/authorized_keys"
fi

cat >"/etc/sudoers.d/90-${USERNAME}" <<SUDOERS
${USERNAME} ALL=(ALL) NOPASSWD:ALL
SUDOERS
chmod 0440 "/etc/sudoers.d/90-${USERNAME}"

log "Installing Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled

log "Bringing Tailscale online (plain sshd over the tailnet; no Tailscale SSH)"
ts_args=(
  --auth-key="${TS_AUTHKEY}"
  --hostname="${TS_HOSTNAME}"
  --accept-dns=true
)
if [[ -n "${TS_TAGS}" ]]; then
  ts_args+=(--advertise-tags="${TS_TAGS}")
fi
tailscale up "${ts_args[@]}"

log "Hardening SSH daemon (admin on port ${ADMIN_SSH_PORT}, key-only)"
sshd_config="/etc/ssh/sshd_config.d/99-devbox-hardening.conf"
cat >"${sshd_config}" <<SSHD
Port ${ADMIN_SSH_PORT}
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
SSHD
systemctl restart ssh

log "Configuring UFW"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw --force enable

log "Bootstrap complete"
printf 'Admin over the tailnet (plain sshd, key-only, no Tailscale-SSH check):\n'
printf '  ssh -p %s %s@%s\n' "${ADMIN_SSH_PORT}" "${USERNAME}" "${TS_HOSTNAME}"
if [[ -z "${TS_TAGS}" ]]; then
  printf 'Reminder: disable Tailscale key expiry for this node (no public fallback) in the admin console (Machines -> ... -> Disable key expiry), or re-run with TS_TAGS set.\n'
fi

