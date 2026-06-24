# Fluncle's Hermes agent image: the pinned Nous Research Hermes gateway plus the
# Fluncle CLI and the Claude Code CLI. Architecture, build, and run details live in
# docs/agents/hermes-agent.md.
#
# BUILD CONTEXT: build from the REPO ROOT (not docs/agents/hermes/) so the
# `copywriting-fluncle` skill is reachable for the COPY below:
#   docker build -f docs/agents/hermes/Dockerfile -t fluncle-hermes:v2026.6.19 .
#
# RUNTIME SECRET (not baked): the `fluncle-observation` `--no-agent` cron shells out
# to `claude -p` (Claude Code, SUBSCRIPTION auth), which authenticates from the
# CLAUDE_CODE_OAUTH_TOKEN env var. That token is a secret — it is NEVER baked into
# the image; it is pulled from the configured 1Password item (see the ops runbook note).
# The image only carries the `claude` binary + the skill; the credential arrives at run
# time. NOTE: --env-file (/etc/hermes.env) delivers it to `docker exec` + AGENT crons, but
# Hermes BLOCKS provider credentials from `--no-agent` cron script envs (GHSA-rhgp-j443-p4rf),
# so observe-sweep.sh reads the token from a 0600 file instead — see
# docs/agents/hermes/cron/README.md § Operational gotchas (do not re-debug these).
FROM nousresearch/hermes-agent:v2026.6.19

# Enrichment toolchain (docs/agents/hermes/cron/README.md): the
# fluncle-track-enrichment skill's analyze-track.ts is `#!/usr/bin/env bun` and
# shells out to `ffmpeg` to decode the preview, so the box needs both on PATH for
# the `--no-agent` enrich-sweep cron. The Nous Hermes base is Debian-based, so
# ffmpeg comes from apt; unzip is also required because bun's installer (below)
# unpacks the binary from a zip; openssh-client because the box.ascii CLI's
# `box ssh`/`box scp` — the `fluncle-render` conductor's transport to the render
# box — shells out to system ssh/scp; dnsutils (`dig`) because the
# `fluncle-healthcheck` cron's dns probe shells out to `dig` to query the
# `dig.fluncle.com` nameserver. One layer, lists cleaned, no recommends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg unzip openssh-client dnsutils \
  && rm -rf /var/lib/apt/lists/*

# Bun — pinned to the repo's toolchain (packageManager bun@1.3.14) so the box runs
# the same interpreter the skill is authored against. The official installer drops
# the binary in /root/.bun (root's HOME, mode 700). The `--no-agent` cron runner
# execs as a NON-root user that can't traverse /root, so a symlink there fails
# (126 Permission denied). COPY the binary to /usr/local/bin (world-traversable)
# instead — a real file outside /root that any user can exec. `fluncle` (npm -g in
# /usr/local/lib) is already world-accessible, so only bun needs this.
ENV BUN_INSTALL=/root/.bun
ENV PATH=/usr/local/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" \
  && cp /root/.bun/bin/bun /usr/local/bin/bun \
  && chmod 755 /usr/local/bin/bun

# box.ascii CLI — the `fluncle-render` `--no-agent` conductor cron drives a
# SCALE-TO-ZERO box.ascii render box: wake it, trigger the render via a
# remote `claude -p`, park it (docs/agents/hermes/cron/README.md § the render
# conductor). The installer drops the binary in $HOME/.ascii/bin (/root, mode 700);
# the non-root cron runner can't traverse /root, so COPY it to /usr/local/bin like
# bun. Run under `sh` it skips the .bashrc/.zshrc shell-integration (writes only the
# binary + a ~/.config/ascii/box/config.json — non-secret api_url/channel, which
# render-conductor.sh re-creates at the cron user's own HOME). Auth is NOT baked:
# the conductor `box login`s from BOX_API_KEY (the configured 1Password item — see
# the ops runbook note) at run, persisting under the cron user's $HOME (the mounted
# agent state dir).
# NOTE: box.ascii is pre-1.0 and its installer offers no version pin — it tracks
# the `ascii-prod` channel (the CLI also self-updates), so this is the one image
# dependency not version-pinned. Re-verify the conductor after a base rebuild.
# Two install-in-Docker quirks the installer trips on: (1) it runs `basename "$SHELL"`
# under `set -u` and $SHELL is unset in a build (→ "parameter not set", exit 2), so set
# SHELL=/bin/sh — which also makes it skip the .bashrc/.zshrc integration (binary +
# config only, clean); (2) it ENDS with an interactive `box onboard` (sign-in) that
# needs a tty and fails in a build (cannot open /dev/tty). The binary is installed
# BEFORE that step and runtime auth is `box login $BOX_API_KEY` (the conductor), so
# ignore the onboard exit (|| true) and assert the binary actually landed (test -x).
RUN export SHELL=/bin/sh \
  && (curl -fsSL https://box.ascii.dev/install | sh || true) \
  && test -x /root/.ascii/bin/box \
  && cp /root/.ascii/bin/box /usr/local/bin/box \
  && chmod 755 /usr/local/bin/box

# Install the Fluncle CLI — the agent's only path to read/write the archive. There
# is no local command gate: the box holds an `agent`-scoped token and the Worker
# refuses publish-/irreversible-class actions for that role server-side, so the
# CLI runs ungated and an attempted publish comes back as a 403 to relay in voice.
# Pinned for reproducible rebuilds (the version line also busts the layer cache on
# a bump); carries the Convention-B renamed surface + `admin newsletter`/backfill
# commands + the `admin tracks note` auto-note command (the `fluncle-note` cron).
# Bump deliberately when a newer release is needed on the box.
RUN npm install -g fluncle@0.60.0

# Claude Code — the `fluncle-observation` `--no-agent` cron's ONE agentic step shells
# out to `claude -p` to author the recovered-audio observation script in Fluncle's
# voice (subscription auth via CLAUDE_CODE_OAUTH_TOKEN at run time; zero OpenRouter
# tokens). Pinned for reproducible rebuilds (the version line busts the layer cache on
# a bump) — matches the box's proven spike version. Bump deliberately, never float
# `latest` (Hermes is pre-1.0; pin the whole toolchain). `npm -g` lands in
# /usr/local/lib + a /usr/local/bin/claude symlink, both world-accessible, so the
# NON-root cron user can exec it (same world-readable property the `fluncle` CLI relies
# on). Bump lever: this version line.
RUN npm install -g @anthropic-ai/claude-code@2.1.186

# The `copywriting-fluncle` skill, baked for Claude Code so the cron's `claude -p`
# can load the full voice canon. CLAUDE DISCOVERS SKILLS UNDER ITS CONFIG DIR
# (<CLAUDE_CONFIG_DIR>/skills/<name>/, default ~/.claude/skills/). The `--no-agent`
# cron runner execs as a NON-root user whose HOME is not knowable at build time, so
# rather than guess that user's ~/.claude we pin the config dir to a world-readable
# baked path via CLAUDE_CONFIG_DIR=/opt/claude and drop the skill at
# /opt/claude/skills/copywriting-fluncle. This makes skill discovery independent of
# the cron user's identity/HOME and survives every rebuild (baked, not host-mounted).
# The dir is world-traversable (755) and made writable (1777, sticky) because Claude
# Code writes session/state files under the config dir at run — the non-root cron user
# must be able to create them without owning /opt/claude; the skill files themselves
# stay root-owned + read-only. COPY needs the repo root as the build context (see the
# header). Update the skill the same way as any image change: edit it in the repo
# (packages/skills/copywriting-fluncle), rebuild, restart.
ENV CLAUDE_CONFIG_DIR=/opt/claude
COPY packages/skills/copywriting-fluncle /opt/claude/skills/copywriting-fluncle
RUN chmod -R a+rX /opt/claude/skills \
  && chmod 1777 /opt/claude
