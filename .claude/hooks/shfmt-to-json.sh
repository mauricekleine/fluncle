#!/usr/bin/env bash
# shellcheck shell=bash


set -o pipefail

HOOKS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./shfmt-helper.sh
. "$HOOKS_DIR/shfmt-helper.sh"

fail() {
  printf 'fluncle shfmt helper: %s\n' "$1" >&2
  exit 3
}

platform=$(shfmt_helper_platform) || \
  fail "this machine is unsupported. The helper supports Linux and macOS on amd64 or arm64."

if ! shfmt_helper_is_verified; then
  "$HOOKS_DIR/setup-shfmt-helper.sh" >&2 || fail "the pinned shfmt helper could not be installed."
fi

exec "$SHFMT_HELPER_BINARY" "$@"
