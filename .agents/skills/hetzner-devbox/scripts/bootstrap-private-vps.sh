#!/usr/bin/env bash
set -Eeuo pipefail

USERNAME="${USERNAME:-admin}"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"

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

log "Bringing Tailscale online"
tailscale up \
  --auth-key="${TS_AUTHKEY}" \
  --hostname="${TS_HOSTNAME}" \
  --ssh \
  --accept-dns=true

log "Hardening SSH daemon"
sshd_config="/etc/ssh/sshd_config.d/99-devbox-hardening.conf"
cat >"${sshd_config}" <<'SSHD'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
SSHD
systemctl reload ssh || systemctl restart ssh

log "Configuring UFW"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw --force enable

log "Bootstrap complete"
printf 'Tailscale SSH should now work with: ssh %s@%s\n' "${USERNAME}" "${TS_HOSTNAME}"

