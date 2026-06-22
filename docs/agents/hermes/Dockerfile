# Fluncle's Hermes agent image: the pinned Nous Research Hermes gateway plus the
# Fluncle CLI. Architecture, build, and run details live in
# docs/agents/hermes-agent.md.
FROM nousresearch/hermes-agent:v2026.6.19

# Enrichment toolchain (docs/spinup-to-hermes-enrichment-brief.md): the
# fluncle-track-enrichment skill's analyze-track.ts is `#!/usr/bin/env bun` and
# shells out to `ffmpeg` to decode the preview, so the box needs both on PATH for
# the `--no-agent` enrich-sweep cron. The Nous Hermes base is Debian-based, so
# ffmpeg comes from apt; unzip is also required because bun's installer (below)
# unpacks the binary from a zip. One layer, lists cleaned, no recommends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg unzip \
  && rm -rf /var/lib/apt/lists/*

# Bun — pinned to the repo's toolchain (packageManager bun@1.3.14) so the box runs
# the same interpreter the skill is authored against. The official installer drops
# the binary at /root/.bun/bin; symlink it onto PATH so `bun` resolves for cron
# scripts and the agent CLI alike. BUN_INSTALL keeps the install path explicit.
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Install the Fluncle CLI — the agent's only path to read/write the archive. There
# is no local command gate: the box holds an `agent`-scoped token and the Worker
# refuses publish-/irreversible-class actions for that role server-side, so the
# CLI runs ungated and an attempted publish comes back as a 403 to relay in voice.
RUN npm install -g fluncle
