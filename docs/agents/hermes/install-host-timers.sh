#!/usr/bin/env bash

set -euo pipefail

DEST="${INSTALL_HOST_TIMERS_DEST:-/etc/systemd/system}"
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADMISSION_RUNNER_SOURCE="${REPO_DIR}/scripts/database-admission-runner.sh"

dry_run=0
refresh_unit_names=()
while [ "$#" -gt 0 ]; do
	case "$1" in
	--dry-run | -n)
		dry_run=1
		shift
		;;
	--refresh-unit)
		if [ "$#" -lt 2 ] || [ -z "$2" ]; then
			echo "install-host-timers.sh: --refresh-unit requires a service or timer basename" >&2
			exit 2
		fi
		refresh_unit_names+=("$2")
		shift 2
		;;
	*)
		echo "usage: install-host-timers.sh [--dry-run] [--refresh-unit NAME ...]" >&2
		exit 2
		;;
	esac
done
refresh_mode=0
if [ "${#refresh_unit_names[@]}" -ne 0 ]; then
	refresh_mode=1
fi

shopt -s nullglob

is_system_binary() {
	case "$1" in
	/bin/* | /sbin/* | /usr/bin/* | /usr/sbin/*) return 0 ;;
	*) return 1 ;;
	esac
}

exec_paths() {
	local unit="$1" line executable payload
	while IFS= read -r line; do

		while :; do
			case "$line" in
			[[:space:]]*) line="${line#?}" ;;
			[-@+!:]*) line="${line#?}" ;;
			*) break ;;
			esac
		done
		[ -n "$line" ] || continue
		executable="${line%%[[:space:]]*}"
		printf '%s\n' "$executable"

		if [ "$(basename "$executable")" = "database-admission-runner.sh" ]; then
			payload="${line#* -- }"
			if [ "$payload" != "$line" ] && [ -n "$payload" ]; then
				printf '%s\n' "${payload%%[[:space:]]*}"
			fi
		fi
	done < <(sed -n 's/^ExecStart=//p' "$unit")
}

rel() {
	printf '%s\n' "${1#"${REPO_DIR}/"}"
}

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

selected_unit_files=()
if [ "$refresh_mode" -eq 1 ]; then
	seen_refresh_names=()
	for requested_name in "${refresh_unit_names[@]}"; do
		case "$requested_name" in
		*.service | *.timer) ;;
		*)
			echo "install-host-timers.sh: refresh unit must be an exact .service or .timer basename: ${requested_name}" >&2
			exit 2
			;;
		esac
		if contains "$requested_name" ${seen_refresh_names[@]+"${seen_refresh_names[@]}"}; then
			echo "install-host-timers.sh: duplicate --refresh-unit selection: ${requested_name}" >&2
			exit 2
		fi
		seen_refresh_names+=("$requested_name")

		matches=()
		for dir in "${unit_dirs[@]}"; do
			for unit in "$dir"/*.service "$dir"/*.timer; do
				if [ "$(basename "$unit")" = "$requested_name" ]; then
					matches+=("$unit")
				fi
			done
		done
		if [ "${#matches[@]}" -eq 0 ]; then
			echo "install-host-timers.sh: unknown refresh unit: ${requested_name}" >&2
			exit 2
		fi
		if [ "${#matches[@]}" -gt 1 ]; then
			{
				echo "install-host-timers.sh: ambiguous refresh unit basename: ${requested_name}"
				printf '  - %s\n' "${matches[@]/#${REPO_DIR}\//}"
			} >&2
			exit 2
		fi
		selected_unit_files+=("${matches[0]}")
	done
fi

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

unit_files=()
host_pairs=()
system_bins=()
unresolved=()

if [ "$refresh_mode" -eq 1 ]; then
	unit_files=("${selected_unit_files[@]}")
else
	for dir in "${unit_dirs[@]}"; do
		for unit in "$dir"/*.service "$dir"/*.timer; do
			unit_files+=("$unit")
		done
	done
fi

for unit in "${unit_files[@]}"; do
	case "$unit" in
	*.service) ;;
	*) continue ;;
	esac
	dir="$(dirname "$unit")"
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
		if [ "$(basename "$exec_path")" = "database-admission-runner.sh" ]; then
			src="$ADMISSION_RUNNER_SOURCE"
		else
			src="${dir}/$(basename "$exec_path")"
		fi
		if [ ! -e "$src" ]; then
			unresolved+=("$(rel "$unit"): ExecStart=${exec_path} has no source at $(rel "$src")")
			continue
		fi
		if ! contains "${src}|${exec_path}" ${host_pairs[@]+"${host_pairs[@]}"}; then
			host_pairs+=("${src}|${exec_path}")
		fi
	done < <(exec_paths "$unit")
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

timers=()
skipped_enables=()
if [ "$refresh_mode" -eq 0 ]; then
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
fi

if [ "$dry_run" -eq 1 ]; then
	printf 'DRY RUN — nothing installed.\n'
	if [ "$refresh_mode" -eq 1 ]; then
		printf 'Would refresh %d selected unit files and %d host scripts; no timers or services would be activated.\n' \
			"${#unit_files[@]}" "${#host_pairs[@]}"
	else
		printf 'Would install %d unit files from %d dirs and %d host scripts; enable %d timers.\n' \
			"${#unit_files[@]}" "${#unit_dirs[@]}" "${#host_pairs[@]}" "${#timers[@]}"
	fi
	exit 0
fi

for unit in "${unit_files[@]}"; do
	install -m 0644 "$unit" "${DEST}/"
done

for pair in ${host_pairs[@]+"${host_pairs[@]}"}; do
	install -D -m 0755 "${pair%%|*}" "${pair##*|}"
done

systemctl daemon-reload

if [ "$refresh_mode" -eq 1 ]; then
	printf 'Refreshed %d selected unit files and %d host scripts; no timers or services activated.\n' \
		"${#unit_files[@]}" "${#host_pairs[@]}"
	if [ "${#host_pairs[@]}" -ne 0 ]; then
		printf '  host script: %s\n' "${host_pairs[@]//|/ -> }"
	fi
	printf '  refreshed: %s\n' "${unit_files[@]/#${REPO_DIR}\//}"
	exit 0
fi

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
