#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REBOOT_STATUS_PORT="${REBOOT_STATUS_PORT:-}"
REBOOT_STATUS_MARKER="${REBOOT_STATUS_MARKER:-/var/run/reboot-required}"

if [[ "${EUID}" -ne 0 ]]; then
	printf 'install-reboot-status.sh must run as root\n' >&2
	exit 1
fi
if [[ ! "${REBOOT_STATUS_PORT}" =~ ^[1-9][0-9]{3,4}$ ]] || ((REBOOT_STATUS_PORT < 1024 || REBOOT_STATUS_PORT > 65535)); then
	printf 'REBOOT_STATUS_PORT must be an unprivileged TCP port\n' >&2
	exit 1
fi
if [[ ! "${REBOOT_STATUS_MARKER}" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
	printf 'REBOOT_STATUS_MARKER must be an absolute path without shell metacharacters\n' >&2
	exit 1
fi
REBOOT_STATUS_BIND="$(tailscale ip -4)"
REBOOT_STATUS_BIND="${REBOOT_STATUS_BIND}" REBOOT_STATUS_PORT="${REBOOT_STATUS_PORT}" python3 - <<'PYTHON'
import ipaddress
import os
assert ipaddress.IPv4Address(os.environ["REBOOT_STATUS_BIND"]) in ipaddress.IPv4Network("100.64.0.0/10"), "tailnet IPv4 required"
PYTHON

install -d -m 0755 /opt/fluncle-reboot-status /etc/fluncle
install -m 0644 "${SCRIPT_DIR}/reboot-status.py" /opt/fluncle-reboot-status/reboot-status.py
cat >/etc/fluncle/reboot-status.env <<ENV
REBOOT_STATUS_BIND=${REBOOT_STATUS_BIND}
REBOOT_STATUS_PORT=${REBOOT_STATUS_PORT}
REBOOT_STATUS_MARKER=${REBOOT_STATUS_MARKER}
ENV
chmod 0644 /etc/fluncle/reboot-status.env
cat >/etc/systemd/system/fluncle-reboot-status.service <<'UNIT'
[Unit]
Description=Read-only pending reboot status
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
DynamicUser=yes
EnvironmentFile=/etc/fluncle/reboot-status.env
ExecStart=/usr/bin/python3 /opt/fluncle-reboot-status/reboot-status.py
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
RestrictAddressFamilies=AF_INET
CapabilityBoundingSet=
RuntimeDirectory=fluncle-reboot-status
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=restart
ReadOnlyPaths=/run/fluncle-reboot-status
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable fluncle-reboot-status.service
systemctl restart fluncle-reboot-status.service
