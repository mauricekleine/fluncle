#!/usr/bin/env bash
# shellcheck shell=bash


SHFMT_HELPER_VERSION=3.14.0

shfmt_helper_project_dir() {
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    printf '%s' "${CLAUDE_PROJECT_DIR%/}"
  else
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd
  fi
}

shfmt_helper_platform() {
  local system=${1:-$(uname -s)}
  local machine=${2:-$(uname -m)}
  local os arch

  case $system in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 1 ;;
  esac

  case $machine in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) return 1 ;;
  esac

  printf '%s_%s' "$os" "$arch"
}

SHFMT_HELPER_PROJECT_DIR=$(shfmt_helper_project_dir)
SHFMT_HELPER_CACHE_HOME=${XDG_CACHE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.cache}
SHFMT_HELPER_CACHE_ROOT=${FLUNCLE_HOOK_CACHE_DIR:-$SHFMT_HELPER_CACHE_HOME/fluncle/hooks}
SHFMT_HELPER_PLATFORM=$(shfmt_helper_platform 2> /dev/null || printf 'unsupported')
SHFMT_HELPER_DIR=$SHFMT_HELPER_CACHE_ROOT/shfmt/$SHFMT_HELPER_VERSION/$SHFMT_HELPER_PLATFORM
SHFMT_HELPER_BINARY=$SHFMT_HELPER_DIR/shfmt

shfmt_helper_sha256() {
  case $1 in
    darwin_amd64) printf '%s' '74255a8087d74a79f5c1307db807e7efa8f062c429e3a05c075550392e0dcfa1' ;;
    darwin_arm64) printf '%s' '4710ba8074a74334069719d5b82f8cb97532e5623bfe43ef7cdb3442101b9cb2' ;;
    linux_amd64) printf '%s' 'fe42021c7272ef2d67ea36cbc3031683c625d0badec733ef3a57b567246a0b66' ;;
    linux_arm64) printf '%s' '8029959a945b5c6f2bc92ce53fca5cf0384c811cc0884b25b196a093a005657a' ;;
    *) return 1 ;;
  esac
}

shfmt_helper_file_sha256() {
  local file=$1

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    return 1
  fi
}

shfmt_helper_is_verified() {
  local platform expected actual

  [ -f "$SHFMT_HELPER_BINARY" ] && [ -x "$SHFMT_HELPER_BINARY" ] || return 1
  platform=$(shfmt_helper_platform) || return 1
  expected=$(shfmt_helper_sha256 "$platform") || return 1
  actual=$(shfmt_helper_file_sha256 "$SHFMT_HELPER_BINARY") || return 1
  [ "$actual" = "$expected" ]
}

shfmt_helper_setup_command() {
  printf '%s/.claude/hooks/setup-shfmt-helper.sh' "$SHFMT_HELPER_PROJECT_DIR"
}
