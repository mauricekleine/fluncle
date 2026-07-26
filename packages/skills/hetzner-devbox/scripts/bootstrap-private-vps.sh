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
# The 1Password CLI (`op`). ON by default for this profile: it is a BASE PREREQUISITE of a
# box that syncs secrets, not optional tooling — see the install block below. Set
# INSTALL_OP=0 only for a private box that will never hold a secret template.
INSTALL_OP="${INSTALL_OP:-1}"
# Pinned only as the debsig policy directory name — 1Password's signing-key id, which is
# part of the vendor's documented install recipe, not a version.
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

# ── 1Password CLI (`op`) ──────────────────────────────────────────────────────
# A BASE PREREQUISITE of this profile, which is why it sits here beside sudo/ufw/sshd
# rather than in the optional groups of install-toolchain.sh. A private box's whole
# secret layer begins with `op inject` (the secrets sync renders its env templates
# through it). With no `op` on PATH that very first call is `command not found`, no env
# file is ever written, and every job on the box then runs credential-less — a silent,
# total failure of the secret layer with nothing to warn you. It must not be something
# a minimal toolchain run can leave out.
#
# It reaches ONLY this profile by construction: the public SSH app server bootstraps
# through bootstrap-rave-vps.sh instead, and that edge deliberately holds no 1Password
# credential at all (SKILL.md § Rotate the agent token — `op` stays off the edge).
#
# Installed from the VENDOR apt repo — keyring + signed sources list, the same shape as
# the Docker install in install-toolchain.sh — rather than a pinned tarball, so ordinary
# `apt-get upgrade` carries the CLI forward instead of letting it rot at a version
# nothing watches. Idempotent: `gpg --yes` overwrites an existing keyring and the repo,
# policy, and debsig-keyring files are all rewritten in place, so a re-run is a no-op
# reinstall. Recipe: https://developer.1password.com/docs/cli/get-started/
if [[ "${INSTALL_OP}" == "1" ]]; then
  log "Installing the 1Password CLI (op)"
  op_arch="$(dpkg --print-architecture)"
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
    | gpg --dearmor --yes --output /usr/share/keyrings/1password-archive-keyring.gpg
  chmod a+r /usr/share/keyrings/1password-archive-keyring.gpg
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/%s stable main\n' \
    "${op_arch}" "${op_arch}" >/etc/apt/sources.list.d/1password.list
  # debsig-verify policy: the vendor signs the .deb itself, on top of the apt repo
  # signature. Both the policy and its keyring live under the signing key's id.
  install -d -m 0755 \
    "/etc/debsig/policies/${OP_DEBSIG_KEY_ID}" \
    "/usr/share/debsig/keyrings/${OP_DEBSIG_KEY_ID}"
  curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol \
    -o "/etc/debsig/policies/${OP_DEBSIG_KEY_ID}/1password.pol"
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
    | gpg --dearmor --yes --output "/usr/share/debsig/keyrings/${OP_DEBSIG_KEY_ID}/debsig.gpg"
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
# Ubuntu 23.04+ ships OpenSSH socket-activated: ssh.socket binds :22 and the
# sshd_config Port directive is silently ignored (sshd -T still reports the
# configured port — misleading). Defeat socket activation so admin sshd actually
# moves to ${ADMIN_SSH_PORT}; otherwise it stays on :22 and the Tailscale-only
# firewall + UFW leave no way in.
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

