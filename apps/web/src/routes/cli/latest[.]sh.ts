import { createFileRoute } from "@tanstack/react-router";

const repository = "mauricekleine/fluncle";

export const Route = createFileRoute("/cli/latest.sh")({
  server: {
    handlers: {
      GET: async () => {
        return new Response(buildInstallerScript(), {
          headers: {
            "Content-Type": "text/x-shellscript; charset=utf-8",
          },
        });
      },
    },
  },
});

function buildInstallerScript(): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    `REPOSITORY="${repository}"`,
    'INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"',
    'BINARY_NAME="${BINARY_NAME:-fluncle}"',
    "",
    "os=\"$(uname -s | tr '[:upper:]' '[:lower:]')\"",
    'arch="$(uname -m)"',
    "",
    'case "$os" in',
    '  darwin) platform="darwin" ;;',
    '  linux) platform="linux" ;;',
    '  *) echo "Unsupported OS: $os" >&2; exit 1 ;;',
    "esac",
    "",
    'case "$arch" in',
    '  arm64|aarch64) cpu="arm64" ;;',
    '  x86_64|amd64) cpu="x64" ;;',
    '  *) echo "Unsupported CPU architecture: $arch" >&2; exit 1 ;;',
    "esac",
    "",
    'asset="fluncle-${platform}-${cpu}"',
    'url="https://github.com/${REPOSITORY}/releases/latest/download/${asset}"',
    "",
    'tmp="$(mktemp)"',
    'cleanup() { rm -f "$tmp"; }',
    "trap cleanup EXIT",
    "",
    "if command -v curl >/dev/null 2>&1; then",
    '  curl -fsSL "$url" -o "$tmp"',
    "elif command -v wget >/dev/null 2>&1; then",
    '  wget -q "$url" -O "$tmp"',
    "else",
    '  echo "Install failed: curl or wget is required." >&2',
    "  exit 1",
    "fi",
    "",
    'mkdir -p "$INSTALL_DIR"',
    'chmod 755 "$tmp"',
    'mv "$tmp" "$INSTALL_DIR/$BINARY_NAME"',
    "trap - EXIT",
    "",
    'echo "Installed $BINARY_NAME to $INSTALL_DIR/$BINARY_NAME"',
    'echo "Run: $INSTALL_DIR/$BINARY_NAME --help"',
    "",
  ].join("\n");
}
