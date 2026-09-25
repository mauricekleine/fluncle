#!/usr/bin/env bash
# shellcheck shell=bash


set -o pipefail

HOOKS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./shfmt-helper.sh
. "$HOOKS_DIR/shfmt-helper.sh"

fail() {
  printf 'fluncle shfmt setup: %s\n' "$1" >&2
  exit 1
}

platform=$(shfmt_helper_platform) || fail "this machine is unsupported. The helper supports Linux and macOS on amd64 or arm64."
expected=$(shfmt_helper_sha256 "$platform") || fail "this machine has no pinned helper artifact."

if shfmt_helper_is_verified; then
  printf 'fluncle shfmt setup: v%s is already installed and verified at %s\n' \
    "$SHFMT_HELPER_VERSION" "$SHFMT_HELPER_BINARY"
  exit 0
fi

case $platform in
  darwin_amd64 | darwin_arm64 | linux_amd64 | linux_arm64) ;;
  *) fail "this machine has no pinned helper artifact." ;;
esac

asset=shfmt_v${SHFMT_HELPER_VERSION}_${platform}
url=https://github.com/mvdan/sh/releases/download/v${SHFMT_HELPER_VERSION}/$asset
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/fluncle-shfmt.XXXXXX") || fail "could not create a temporary directory."
temporary_binary=$temporary_dir/$asset

cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

if command -v curl >/dev/null 2>&1; then
  curl --fail --location --silent --show-error "$url" --output "$temporary_binary" || \
    fail "could not download $url. Check your connection and run $(shfmt_helper_setup_command) again."
elif command -v wget >/dev/null 2>&1; then
  wget --quiet --output-document="$temporary_binary" "$url" || \
    fail "could not download $url. Check your connection and run $(shfmt_helper_setup_command) again."
else
  fail "curl or wget is required to download the helper. Install one, then run $(shfmt_helper_setup_command) again."
fi

actual=$(shfmt_helper_file_sha256 "$temporary_binary") || \
  fail "no SHA-256 tool is available. Install shasum or sha256sum, then run $(shfmt_helper_setup_command) again."
if [ "$actual" != "$expected" ]; then
  fail "downloaded helper checksum mismatch. Expected $expected, got $actual. Nothing was installed; run $(shfmt_helper_setup_command) again."
fi

chmod 755 "$temporary_binary" || fail "could not mark the verified helper executable."
mkdir -p "$SHFMT_HELPER_DIR" || fail "could not create $SHFMT_HELPER_DIR."
mv "$temporary_binary" "$SHFMT_HELPER_BINARY" || fail "could not install the verified helper."

if ! shfmt_helper_is_verified; then
  fail "the installed helper did not verify. Remove $SHFMT_HELPER_BINARY and run $(shfmt_helper_setup_command) again."
fi

printf 'fluncle shfmt setup: installed and verified v%s at %s\n' \
  "$SHFMT_HELPER_VERSION" "$SHFMT_HELPER_BINARY"
