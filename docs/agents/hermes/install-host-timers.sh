#!/usr/bin/env bash
# install-host-timers.sh — install (or refresh) EVERY Fluncle host systemd timer on the
# rave-02 host FROM THE REPO, so a bare re-provision restores the whole SCHEDULE as code.
#
# This is the "schedule" half of the reset boundary (docs/agents/hermes-agent.md): a reset
# restores CODE (baked into the image, Unit A) + SCHEDULE (these timer units) +
# SECRETS (fluncle-secrets-sync from 1Password). The gateway then holds NO automation crons;
# the Discord chat agent (`gateway run`) is untouched.
#
# Run on the rave-02 HOST (not inside the container), from a repo checkout, as root:
#     sudo bash docs/agents/hermes/install-host-timers.sh
#
# It discovers every unit under docs/agents/hermes/*-timer/ (+ pin-watch/), installs each
# .service + .timer into /etc/systemd/system/, daemon-reloads once, then enables + starts each
# .timer. Idempotent: re-running refreshes the units in place (safe to run after every merge or
# on every re-provision). The per-job rendered unit files stay in the repo as the source of
# truth — this script only lays them down.
#
# FIRST-EVER provision note: `enable --now` starts every timer, including the two that were
# operator-gated at first deploy (fluncle-embed needs a peak-RAM validation on a real captured
# track; fluncle-capture needs the private bucket to exist). This script assumes a
# PREVIOUSLY-VALIDATED box (a re-provision). On a brand-new box, follow each timer README's
# gate (embed-timer/README.md, capture-timer/README.md) before trusting those two.
set -euo pipefail

DEST=/etc/systemd/system
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-host-timers.sh must run as root (sudo)." >&2
  exit 1
fi

if [ ! -d "$DEST" ]; then
  echo "no ${DEST} — is this a systemd host?" >&2
  exit 1
fi

shopt -s nullglob

# Every host-timer dir. The *-timer/ dirs are the migrated automation crons; pin-watch/ is the
# self-updating rebuild timer (same layout, different dir name). capture-timer/embed-timer/
# healthcheck-timer are already-migrated and included so a re-provision restores them too.
# sweep-failure/ is not a timer at all — it holds the `fluncle-sweep-failure@.service` template
# unit that every sweep's `OnFailure=` fires; installing it here restores the failure-alert path
# as code (it has no .timer, so the enable loop below leaves it alone — templates aren't enabled).
unit_dirs=("${REPO_DIR}"/*-timer "${REPO_DIR}"/pin-watch "${REPO_DIR}"/sweep-failure)

installed=()
for dir in "${unit_dirs[@]}"; do
  [ -d "$dir" ] || continue
  for unit in "$dir"/*.service "$dir"/*.timer; do
    [ -e "$unit" ] || continue
    install -m 0644 "$unit" "${DEST}/"
    installed+=("$(basename "$unit")")
  done
done

if [ "${#installed[@]}" -eq 0 ]; then
  echo "no unit files found under ${REPO_DIR}/*-timer or ${REPO_DIR}/pin-watch" >&2
  exit 1
fi

# The sweep-failure template unit's ExecStart runs a HOST script (it queries host systemd for
# the failed unit's exit status, which the container can't). Lay it down at the deployed path
# the unit references, so the OnFailure alert path restores as code on a bare re-provision.
sweep_failure_script="${REPO_DIR}/sweep-failure/fluncle-sweep-failure-notify.sh"
if [ -e "$sweep_failure_script" ]; then
  install -D -m 0755 "$sweep_failure_script" /opt/fluncle-sweep-failure/fluncle-sweep-failure-notify.sh
  installed+=("fluncle-sweep-failure-notify.sh")
fi

systemctl daemon-reload

enabled=()
for dir in "${unit_dirs[@]}"; do
  [ -d "$dir" ] || continue
  for timer in "$dir"/*.timer; do
    [ -e "$timer" ] || continue
    name="$(basename "$timer")"
    systemctl enable --now "$name"
    enabled+=("$name")
  done
done

printf 'Installed %d unit files, enabled %d timers.\n' "${#installed[@]}" "${#enabled[@]}"
printf '  enabled: %s\n' "${enabled[@]}"
echo
systemctl list-timers 'fluncle-*' 'pin-watch*' --no-pager || true
