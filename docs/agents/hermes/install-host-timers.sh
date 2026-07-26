#!/usr/bin/env bash
# install-host-timers.sh — install (or refresh) EVERY Fluncle host systemd unit on the
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
# Preview the plan without touching the host (no root needed — this is what the CI test runs):
#     bash docs/agents/hermes/install-host-timers.sh --dry-run
#
# WHAT IT DOES, AND WHY IT DERIVES EVERYTHING
# -------------------------------------------
# It DISCOVERS its own work rather than being told:
#
#   1. Unit dirs — every directory beside this script that actually contains a `.service` or
#      a `.timer`. It is NOT a hand-maintained list. A hand-maintained list is precisely what
#      broke this script before: it named `*-timer` + `pin-watch` + `sweep-failure`, so
#      `secrets/` fell outside it and `fluncle-secrets-sync` was never installed — every
#      sweep timer got enabled and fired on schedule into a box with no credentials at all.
#   2. Host scripts — every `ExecStart=` that runs a HOST path (anything outside the distro
#      bindirs) gets its script laid down at exactly that path, sourced from the file of the
#      same name in the unit's own directory. Previously only the sweep-failure helper was
#      installed, so `pin-watch.timer` was enabled against a missing ExecStart and the box
#      permanently lost self-deploy.
#
# Both failures printed a success line and exited 0, and `systemctl list-timers` read green
# over them. That is the whole reason for the two rules below.
#
# The sweeps' own `/opt/hermes-scripts/*.sh` are NOT installed here: those run INSIDE the
# container (`docker exec …`), are baked into the image, and are refreshed by pin-watch.
#
# HONESTY CONTRACT: never exit 0 having silently skipped something. Every `ExecStart=` is
# pre-flighted BEFORE anything is installed or enabled, and an unresolved host path aborts
# the run — a half-installed box that reads green is worse than a loud failure. The closing
# summary states what was installed AND what was deliberately skipped.
#
# Idempotent: re-running refreshes the units and host scripts in place (safe after every
# merge and on every re-provision). The per-job rendered unit files stay in the repo as the
# source of truth — this script only lays them down.
#
# FIRST-EVER provision note: `enable --now` starts every timer, including the two that were
# operator-gated at first deploy (fluncle-embed needs a peak-RAM validation on a real captured
# track; fluncle-capture needs the private bucket to exist). This script assumes a
# PREVIOUSLY-VALIDATED box (a re-provision). On a brand-new box, follow each timer README's
# gate (embed-timer/README.md, capture-timer/README.md) before trusting those two.
#
# Guarded by docs/agents/hermes/scripts/install-host-timers.test.ts: it runs the `--dry-run`
# plan in CI and fails the build if any unit dir, timer, or host script this repo holds is
# missing from the plan.
set -euo pipefail

DEST=/etc/systemd/system
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run | -n)
      dry_run=1
      ;;
    *)
      echo "usage: install-host-timers.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [ "$dry_run" -eq 0 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "install-host-timers.sh must run as root (sudo), or pass --dry-run to preview." >&2
    exit 1
  fi

  if [ ! -d "$DEST" ]; then
    echo "no ${DEST} — is this a systemd host?" >&2
    exit 1
  fi
fi

shopt -s nullglob

# A path under a distro bindir is OS-provided (docker, systemd-run, …) and never laid down by
# this script. Anything else an ExecStart runs is a Fluncle host script and IS ours to install.
is_system_binary() {
  case "$1" in
    /bin/* | /sbin/* | /usr/bin/* | /usr/sbin/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Print the executable of every `ExecStart=` line in a unit, one per line. systemd allows the
# optional prefix characters `-@+!:` before the executable, so strip those from the FRONT,
# then take the first whitespace-separated token. The rest of the line is arguments — for a
# `docker exec` unit those name IN-CONTAINER paths, which is exactly why only the executable
# is classified here.
exec_paths() {
  local unit="$1" line
  while IFS= read -r line; do
    # Trim leading whitespace, then the systemd prefix characters, one at a time. (Two arms:
    # `-` has to lead its own bracket expression or it reads as a range.)
    while :; do
      case "$line" in
        [[:space:]]*) line="${line#?}" ;;
        [-@+!:]*) line="${line#?}" ;;
        *) break ;;
      esac
    done
    [ -n "$line" ] || continue
    printf '%s\n' "${line%%[[:space:]]*}"
  done < <(sed -n 's/^ExecStart=//p' "$unit")
}

# A path relative to the hermes dir, for readable output.
rel() {
  printf '%s\n' "${1#"${REPO_DIR}/"}"
}

# Is $1 already among the remaining arguments? (Bash 3.2 has no associative arrays, and these
# lists are tens of entries, so a linear scan is the honest tool.)
contains() {
  local needle="$1" item
  shift
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

plan() {
  if [ "$dry_run" -eq 1 ]; then
    printf 'plan: %s\n' "$*"
  fi
}

# ---------------------------------------------------------------------------------------
# 1. DERIVE the unit dirs: every directory beside this script holding a .service/.timer.
# ---------------------------------------------------------------------------------------
unit_dirs=()
skipped_dirs=()
for dir in "${REPO_DIR}"/*/; do
  dir="${dir%/}"
  dir_units=("$dir"/*.service "$dir"/*.timer)
  if [ "${#dir_units[@]}" -eq 0 ]; then
    skipped_dirs+=("$(rel "$dir")")
    plan "skip-dir $(rel "$dir") (holds no .service/.timer)"
    continue
  fi
  unit_dirs+=("$dir")
  plan "unit-dir $(rel "$dir")"
done

if [ "${#unit_dirs[@]}" -eq 0 ]; then
  echo "no unit files (*.service / *.timer) found in any directory under ${REPO_DIR}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# 2. PRE-FLIGHT every ExecStart BEFORE touching the host. A unit that runs a host path needs
#    that script laid down; its source is the file of the same name in the unit's own dir.
# ---------------------------------------------------------------------------------------
unit_files=()
host_pairs=() # "<source path>|<destination path>"
system_bins=()
unresolved=()

for dir in "${unit_dirs[@]}"; do
  for unit in "$dir"/*.service "$dir"/*.timer; do
    unit_files+=("$unit")
  done
  for unit in "$dir"/*.service; do
    while IFS= read -r exec_path; do
      case "$exec_path" in
        /*) ;;
        *)
          unresolved+=("$(rel "$unit"): ExecStart is not an absolute path (${exec_path})")
          continue
          ;;
      esac
      if is_system_binary "$exec_path"; then
        if ! contains "$exec_path" ${system_bins[@]+"${system_bins[@]}"}; then
          system_bins+=("$exec_path")
        fi
        continue
      fi
      src="${dir}/$(basename "$exec_path")"
      if [ ! -e "$src" ]; then
        unresolved+=("$(rel "$unit"): ExecStart=${exec_path} has no source at $(rel "$src")")
        continue
      fi
      if ! contains "${src}|${exec_path}" ${host_pairs[@]+"${host_pairs[@]}"}; then
        host_pairs+=("${src}|${exec_path}")
      fi
    done < <(exec_paths "$unit")
  done
done

if [ "${#unresolved[@]}" -ne 0 ]; then
  {
    echo "install-host-timers.sh: REFUSING to install — unresolved ExecStart host paths:"
    printf '  - %s\n' "${unresolved[@]}"
    echo "Put the script beside its unit in the repo, or point the unit at a path this installer lays down."
  } >&2
  exit 1
fi

for pair in ${host_pairs[@]+"${host_pairs[@]}"}; do
  plan "host-script $(rel "${pair%%|*}") -> ${pair##*|}"
done
for unit in "${unit_files[@]}"; do
  plan "unit $(rel "$unit")"
done

# ---------------------------------------------------------------------------------------
# 3. Which timers get enabled. A template unit (`name@.service`) is instantiated on demand by
#    the `OnFailure=` that references it and is never enabled directly.
# ---------------------------------------------------------------------------------------
timers=()
skipped_enables=()
for dir in "${unit_dirs[@]}"; do
  for timer in "$dir"/*.timer; do
    name="$(basename "$timer")"
    case "$name" in
      *@*)
        skipped_enables+=("${name} (template unit — instantiated on demand, never enabled)")
        continue
        ;;
    esac
    timers+=("$name")
  done
  for service in "$dir"/*@.service; do
    skipped_enables+=("$(basename "$service") (template unit — instantiated on demand, never enabled)")
  done
done

if [ "${#timers[@]}" -eq 0 ]; then
  echo "no .timer units found under ${REPO_DIR} — refusing to install a schedule with nothing in it" >&2
  exit 1
fi

# Secrets first: on a re-provision the sweeps must not start ticking before 1Password has
# materialized the box's credentials. The rest keep glob (alphabetical) order.
ordered_timers=()
for name in "${timers[@]}"; do
  if [ "$name" = "fluncle-secrets-sync.timer" ]; then
    ordered_timers+=("$name")
  fi
done
for name in "${timers[@]}"; do
  if [ "$name" != "fluncle-secrets-sync.timer" ]; then
    ordered_timers+=("$name")
  fi
done
timers=("${ordered_timers[@]}")

for name in "${timers[@]}"; do
  plan "timer ${name}"
done

if [ "$dry_run" -eq 1 ]; then
  printf 'DRY RUN — nothing installed.\n'
  printf 'Would install %d unit files from %d dirs and %d host scripts; enable %d timers.\n' \
    "${#unit_files[@]}" "${#unit_dirs[@]}" "${#host_pairs[@]}" "${#timers[@]}"
  exit 0
fi

# ---------------------------------------------------------------------------------------
# 4. Install: units read-only at 0644, host scripts executable at 0755. `install -D` creates
#    the parent dir, so /opt/fluncle-* need not pre-exist on a bare box.
# ---------------------------------------------------------------------------------------
for unit in "${unit_files[@]}"; do
  install -m 0644 "$unit" "${DEST}/"
done

for pair in ${host_pairs[@]+"${host_pairs[@]}"}; do
  install -D -m 0755 "${pair%%|*}" "${pair##*|}"
done

systemctl daemon-reload

# ---------------------------------------------------------------------------------------
# 5. Enable. Secrets sync also gets one immediate best-effort run so a fresh box holds its
#    credentials before the first sweep tick — without letting a missing bootstrap env abort
#    the install (its timer retries every 15 min regardless).
# ---------------------------------------------------------------------------------------
enabled=()
for name in "${timers[@]}"; do
  systemctl enable --now "$name"
  enabled+=("$name")
  if [ "$name" = "fluncle-secrets-sync.timer" ]; then
    if ! systemctl start fluncle-secrets-sync.service; then
      echo "WARNING: fluncle-secrets-sync.service failed its first run — the box may hold no credentials." >&2
      echo "         Check /etc/hermes-bootstrap.env and \`journalctl -u fluncle-secrets-sync\`." >&2
    fi
  fi
done

# ---------------------------------------------------------------------------------------
# 6. Summary — what was installed AND what was deliberately skipped.
# ---------------------------------------------------------------------------------------
printf 'Installed %d unit files from %d dirs and %d host scripts; enabled %d timers.\n' \
  "${#unit_files[@]}" "${#unit_dirs[@]}" "${#host_pairs[@]}" "${#enabled[@]}"
if [ "${#host_pairs[@]}" -ne 0 ]; then
  printf '  host script: %s\n' "${host_pairs[@]//|/ -> }"
fi
printf '  enabled: %s\n' "${enabled[@]}"
if [ "${#skipped_enables[@]}" -ne 0 ]; then
  printf '  skipped (not enabled): %s\n' "${skipped_enables[@]}"
fi
if [ "${#skipped_dirs[@]}" -ne 0 ]; then
  printf '  skipped (no unit files): %s\n' "${skipped_dirs[@]}"
fi
if [ "${#system_bins[@]}" -ne 0 ]; then
  printf '  assumed present (OS-provided): %s\n' "${system_bins[@]}"
fi
echo
systemctl list-timers 'fluncle-*' 'pin-watch*' --no-pager || true
