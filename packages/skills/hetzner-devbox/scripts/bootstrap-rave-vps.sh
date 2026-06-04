#!/usr/bin/env bash
set -Eeuo pipefail

USERNAME="${USERNAME:-admin}"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"
APP_USER="${APP_USER:-fluncle-ssh}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_HOME="${APP_HOME:-/var/lib/fluncle-ssh}"
APP_DIR="${APP_DIR:-/opt/fluncle-ssh}"
ADMIN_SSH_PORT="${ADMIN_SSH_PORT:-2222}"

if [[ "${EUID}" -ne 0 ]]; then
  printf 'bootstrap-rave-vps.sh must run as root\n' >&2
  exit 1
fi

if [[ -z "${TS_AUTHKEY:-}" ]]; then
  printf 'TS_AUTHKEY is required\n' >&2
  exit 1
fi

log() {
  printf '\n==> %s\n' "$*"
}

log "Installing base public SSH app packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg sudo ufw openssh-server fail2ban

log "Creating private admin user ${USERNAME}"
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

log "Bringing Tailscale online"
tailscale up \
  --auth-key="${TS_AUTHKEY}" \
  --hostname="${TS_HOSTNAME}" \
  --ssh \
  --accept-dns=true

log "Creating locked app user ${APP_USER}"
if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${APP_GROUP}"
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd \
    --system \
    --home-dir "${APP_HOME}" \
    --shell /usr/sbin/nologin \
    --gid "${APP_GROUP}" \
    "${APP_USER}"
fi

install -d -m 0755 -o root -g root "${APP_DIR}"
install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${APP_HOME}"

log "Hardening OpenSSH for private admin access"
sshd_config="/etc/ssh/sshd_config.d/99-rave-admin-hardening.conf"
cat >"${sshd_config}" <<SSHD
Port ${ADMIN_SSH_PORT}
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
SSHD
systemctl reload ssh || systemctl restart ssh

log "Configuring UFW"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'public fluncle ssh app'
ufw allow in on tailscale0 comment 'tailnet admin access'
ufw --force enable

log "Enabling fail2ban"
systemctl enable --now fail2ban || true

log "Bootstrap complete"
printf 'Public TCP/22 is reserved for the app. Admin SSH should use Tailscale:\n'
printf '  ssh -p %s %s@%s\n' "${ADMIN_SSH_PORT}" "${USERNAME}" "${TS_HOSTNAME}"
