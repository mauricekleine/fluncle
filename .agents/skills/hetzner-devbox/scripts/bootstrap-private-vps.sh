#!/usr/bin/env bash
set -Eeuo pipefail

USERNAME="${USERNAME:-admin}"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"

ADMIN_SSH_PORT="${ADMIN_SSH_PORT:-2222}"

TS_TAGS="${TS_TAGS:-}"

INSTALL_OP="${INSTALL_OP:-1}"

OP_DEBSIG_KEY_ID="AC2D62742012EA22"

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

if [[ "${INSTALL_OP}" == "1" ]]; then
	log "Installing the 1Password CLI (op)"
	op_arch="$(dpkg --print-architecture)"
	curl -fsSL https://downloads.1password.com/linux/keys/1password.asc |
		gpg --dearmor --yes --output /usr/share/keyrings/1password-archive-keyring.gpg
	chmod a+r /usr/share/keyrings/1password-archive-keyring.gpg
	printf 'deb [arch=%s signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/%s stable main\n' \
		"${op_arch}" "${op_arch}" >/etc/apt/sources.list.d/1password.list

	install -d -m 0755 \
		"/etc/debsig/policies/${OP_DEBSIG_KEY_ID}" \
		"/usr/share/debsig/keyrings/${OP_DEBSIG_KEY_ID}"
	curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol \
		-o "/etc/debsig/policies/${OP_DEBSIG_KEY_ID}/1password.pol"
	curl -fsSL https://downloads.1password.com/linux/keys/1password.asc |
		gpg --dearmor --yes --output "/usr/share/debsig/keyrings/${OP_DEBSIG_KEY_ID}/debsig.gpg"
	apt-get update
	apt-get install -y --no-install-recommends 1password-cli
	op --version
fi

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

systemctl disable --now ssh.socket 2>/dev/null || true
systemctl enable ssh.service
systemctl restart ssh.service

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
