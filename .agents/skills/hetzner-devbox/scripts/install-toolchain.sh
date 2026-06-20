#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
if [[ -z "${ENV_FILE:-}" ]]; then
  if [[ -f "${SKILL_DIR}/.env" ]]; then
    ENV_FILE="${SKILL_DIR}/.env"
  elif [[ -f ".env" ]]; then
    ENV_FILE=".env"
  else
    ENV_FILE="${SKILL_DIR}/.env"
  fi
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

SERVER_NAME="${SERVER_NAME:-agent-devbox-01}"
USERNAME="${USERNAME:-admin}"
# Admin sshd listens on this port over the tailnet (see bootstrap-*-vps.sh). Plain
# OpenSSH on :2222, NOT Tailscale SSH on :22, so headless installs never hit a
# Tailscale-SSH "check" re-auth prompt.
ADMIN_SSH_PORT="${ADMIN_SSH_PORT:-2222}"
BUN_VERSION="${BUN_VERSION:-1.2.15}"

INSTALL_DOCKER="${INSTALL_DOCKER:-1}"
INSTALL_GH="${INSTALL_GH:-1}"
INSTALL_BUN="${INSTALL_BUN:-1}"
INSTALL_UV="${INSTALL_UV:-1}"
INSTALL_NODE_LTS="${INSTALL_NODE_LTS:-1}"
INSTALL_CODEX="${INSTALL_CODEX:-1}"
INSTALL_CLAUDE="${INSTALL_CLAUDE:-1}"
INSTALL_REMOTION_LIBS="${INSTALL_REMOTION_LIBS:-0}"

remote_env=$(printf 'BUN_VERSION=%q INSTALL_DOCKER=%q INSTALL_GH=%q INSTALL_BUN=%q INSTALL_UV=%q INSTALL_NODE_LTS=%q INSTALL_CODEX=%q INSTALL_CLAUDE=%q INSTALL_REMOTION_LIBS=%q' \
  "${BUN_VERSION}" \
  "${INSTALL_DOCKER}" \
  "${INSTALL_GH}" \
  "${INSTALL_BUN}" \
  "${INSTALL_UV}" \
  "${INSTALL_NODE_LTS}" \
  "${INSTALL_CODEX}" \
  "${INSTALL_CLAUDE}" \
  "${INSTALL_REMOTION_LIBS}")

ssh -o BatchMode=yes -o ConnectTimeout=30 -p "${ADMIN_SSH_PORT}" "${USERNAME}@${SERVER_NAME}" "${remote_env} bash -s" <<'REMOTE'
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

log() {
  printf '\n==> %s\n' "$*"
}

is_enabled() {
  [[ "${1:-}" == "1" || "${1:-}" == "true" || "${1:-}" == "yes" ]]
}

base_packages=(
  git tmux zsh curl wget jq unzip ripgrep fd-find htop tree
  ca-certificates gnupg lsb-release build-essential pkg-config
  python3 python3-pip python3-venv nodejs npm
)

if is_enabled "${INSTALL_REMOTION_LIBS}"; then
  base_packages+=(libnspr4 libnss3)
fi

log "Installing base development packages"
sudo apt-get update
sudo apt-get install -y --no-install-recommends "${base_packages[@]}"

log "Configuring user-local paths"
mkdir -p "$HOME/.local/bin" "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
ln -sfn /usr/bin/fdfind "$HOME/.local/bin/fd"
for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  touch "$profile"
  grep -q 'npm-global/bin' "$profile" || printf '\n# User-local npm globals\nexport PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"\n' >> "$profile"
  grep -q '.bun/bin' "$profile" || printf '\n# Bun\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' >> "$profile"
  grep -q 'N_PREFIX' "$profile" || printf '\n# User-local Node managed by n\nexport N_PREFIX="$HOME/.local"\nexport PATH="$N_PREFIX/bin:$PATH"\n' >> "$profile"
done
export N_PREFIX="$HOME/.local"
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"

if is_enabled "${INSTALL_DOCKER}"; then
  log "Installing Docker Engine and Compose plugin"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$(whoami)"
  sudo systemctl enable --now docker
fi

if is_enabled "${INSTALL_GH}"; then
  log "Installing GitHub CLI"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y gh
fi

if is_enabled "${INSTALL_BUN}"; then
  log "Installing Bun ${BUN_VERSION}"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  export PATH="$HOME/.bun/bin:$PATH"
fi

if is_enabled "${INSTALL_UV}"; then
  log "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

if is_enabled "${INSTALL_NODE_LTS}"; then
  log "Installing current Node LTS user-locally"
  npm install -g n
  n lts
  hash -r
fi

if is_enabled "${INSTALL_CODEX}"; then
  log "Installing Codex CLI"
  npm install -g @openai/codex
fi

if is_enabled "${INSTALL_CLAUDE}"; then
  log "Installing Claude Code native CLI"
  curl -fsSL https://claude.ai/install.sh | bash
fi

log "Versions"
bash -lc 'node --version || true; npm --version || true; git --version || true; tmux -V || true; zsh --version || true; jq --version || true; rg --version | head -n 1 || true; fd --version || true; docker --version || true; docker compose version || true; gh --version | head -n 1 || true; bun --version || true; uv --version || true; codex --version || true; claude --version || true'
REMOTE

