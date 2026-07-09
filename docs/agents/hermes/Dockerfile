# Fluncle's Hermes agent image: the pinned Nous Research Hermes gateway plus the
# Fluncle CLI and the Claude Code CLI. Architecture, build, and run details live in
# docs/agents/hermes-agent.md.
#
# BUILD CONTEXT: build from the REPO ROOT (not docs/agents/hermes/) so the
# `copywriting-fluncle` skill is reachable for the COPY below:
#   docker build -f docs/agents/hermes/Dockerfile -t fluncle-hermes:v2026.7.1 .
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
#
# DURABILITY (RFC Unit B): the base is DIGEST-PINNED (not the mutable :v2026.7.7.2 tag) so a
# cached venv layer can never sit on a silently-drifted base — the flake that once shipped a
# broken embed engine. To bump the base deliberately, re-resolve the digest + update this line:
#   docker inspect nousresearch/hermes-agent:v2026.7.7.2 --format '{{index .RepoDigests 0}}'
FROM nousresearch/hermes-agent@sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973

# Enrichment toolchain (docs/agents/hermes/cron/README.md): the
# fluncle-track-enrichment skill's analyze-track.ts is `#!/usr/bin/env bun` and
# shells out to `ffmpeg` to decode the preview, so the box needs both on PATH for
# the `--no-agent` enrich-sweep cron. The Nous Hermes base is Debian-based, so
# ffmpeg comes from apt; unzip is also required because bun's installer (below)
# unpacks the binary from a zip; openssh-client because the box.ascii CLI's
# `box ssh`/`box scp` — the `fluncle-render` conductor's transport to the render
# box — shells out to system ssh/scp; dnsutils (`dig`) because the
# `fluncle-healthcheck` cron's dns probe shells out to `dig` to query the
# `dig.fluncle.com` nameserver; fonts-dejavu-core supplies DejaVu Sans Bold at
# /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf — the TITLE face for the
# Fluncle Studio clip cut (BOX_CLIP_SANS_FONT_FILE in apps/cli/src/commands/clips.ts).
# It stands in for the Remotion trackLine's `ui-sans-serif, system-ui, sans-serif`,
# which is not an embedded webfont there, so headless Chromium renders it as its generic
# `sans-serif` = DejaVu on Debian; baking the same font makes the clip match the render.
# One layer, lists cleaned, no recommends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg unzip openssh-client dnsutils fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Bake a PINNED yt-dlp (the fluncle-capture sweep's fetcher) in its OWN EARLY layer — above the
# frequently-bumped fluncle/claude pins — so a routine pin-watch rebuild never busts this 40MB
# download (only a base/apt change does). A 40MB binary, never committed to this public repo;
# bumped deliberately (a watched pin is a follow-up). `mkdir -p` because the sweep-script COPY
# that creates /opt/hermes-scripts comes later; chmod 755 so the non-root cron user execs it.
RUN mkdir -p /opt/hermes-scripts \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux \
       -o /opt/hermes-scripts/yt-dlp \
  && chmod 755 /opt/hermes-scripts/yt-dlp

# ── MuQ audio-embedding toolchain (the `fluncle-embed` cron) ──────────────────
# The `fluncle-embed` `--no-agent` cron (docs/agents/hermes/scripts/embed-sweep.*)
# runs MuQ-large on the box to compute a 1024-d audio embedding per finding — the
# sonic-similarity space that powers "more like this" (docs/track-lifecycle.md).
# The spike's load-bearing lesson: MuQ's torch family (torch + torchaudio +
# torchvision) must be MATCHED CPU builds, installed together from the pytorch CPU
# index BEFORE `muq`, on Python 3.11 — so it is a PINNED image layer (never a runtime
# `pip install`), in its own venv, with the model weights baked so `from_pretrained`
# resolves offline on a cold start. Heavy + rarely-changing → early for cache reuse.
#
# THE PYTHON 3.11 SOURCE: muq requires Python <3.12, but the Nous Hermes base is now
# Debian trixie (13), which ships only python3.13 in apt (verified: the apt-python3.11
# path failed a build). The base already carries `uv` (astral), so we install a
# standalone python3.11 with it (`uv python install 3.11` → a cp311 python-build-
# standalone) and seed a venv from it — no PPA, no from-source build. Re-verify on a
# base bump: if `uv` ever leaves the base, install it (curl https://astral.sh/uv).
#
# THE ORDERING LAW (spike-verified on rave-02 CPX32; a mismatch is why the ad-hoc
# install took four attempts): install the CPU torch TRIO from the pytorch CPU index
# in its OWN pip step, THEN `muq` (+ numpy) in a SECOND step. If muq installs in the
# same resolve as torch, it drags in CUDA torchaudio/torchvision and the import fails.
# The `--index-url .../cpu` is what resolves torch==2.12.1 to the +cpu build. Pins are
# the exact set the spike validated (torch trio + muq 0.1.0 + numpy 2.4.4; ~2.85 GB
# peak, ~16 s/track). The venv is cp311, so the CPU torch wheels match. World-readable
# (a+rX) so the non-root cron user reads it.
ENV MUQ_VENV=/opt/muq-venv
ENV HF_HOME=/opt/muq-cache
# DURABILITY (RFC Unit B): relocate uv's standalone python OUT of /root (mode 700 — the
# non-root cron user can't traverse it, so the venv's interpreter symlink would dangle for
# `docker exec -u hermes`) into a world-readable baked path — the same "cp out of /root"
# pattern the bun/box blocks below apply. Patch-pin 3.11.15 (what the working image resolved
# to) instead of floating 3.11 so the python-build-standalone target is deterministic across
# rebuilds. The operator confirms 3.11.15 still resolves during the attended `--force` rebuild
# (fall back to the nearest cp311 patch if uv ever drops it).
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv python install 3.11.15 \
  && uv venv --python 3.11.15 --seed "${MUQ_VENV}" \
  && "${MUQ_VENV}/bin/pip" install --no-cache-dir --upgrade pip \
  && "${MUQ_VENV}/bin/pip" install --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu \
       torch==2.12.1 torchaudio==2.11.0 torchvision==0.27.1 \
  && "${MUQ_VENV}/bin/pip" install --no-cache-dir muq==0.1.0 numpy==2.4.4 \
  && HF_HOME="${HF_HOME}" "${MUQ_VENV}/bin/python" -c \
       "from muq import MuQ; MuQ.from_pretrained('OpenMuQ/MuQ-large-msd-iter')" \
  && chmod -R a+rX "${MUQ_VENV}" "${HF_HOME}" /opt/uv-python

# Bun — pinned to the repo's toolchain (packageManager bun@1.3.14) so the box runs
# the same interpreter the skill is authored against. The official installer drops
# the binary in /root/.bun (root's HOME, mode 700). The `--no-agent` cron runner
# execs as a NON-root user that can't traverse /root, so a symlink there fails
# (126 Permission denied). COPY the binary to /usr/local/bin (world-traversable)
# instead — a real file outside /root that any user can exec. `fluncle` is the standalone
# binary copied to /usr/local/bin (the install block below), already world-accessible, so
# only bun needs this cp-out-of-/root dance.
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
#
# This is the STANDALONE bun-compiled binary, NOT the `npm -g` thin client: the
# clip-cut + media-upload commands use the Bun runtime (Bun.spawn/Bun.file), and the
# npm package ships a `#!/usr/bin/env node` shebang — so under node those throw "Bun is
# not defined" (the cut surfaces it as a misleading "ffmpeg missing"). The standalone
# binary embeds bun, so every command runs on the box. `fluncle version` reports this
# version (baked via `--define` at release build), which is how pin-watch's pre-smoke
# validates it. Pinned for reproducible rebuilds (the URL version busts the layer cache);
# bump deliberately — pin-watch + hermes-pin-drift parse the `releases/download/v<ver>/`
# URL below. Released by the repo's `cli-release.yml`; carries the Convention-B renamed
# surface + `admin newsletter`/backfill + `admin tracks note` (the `fluncle-note` cron) +
# the Fluncle Studio `admin clips list`/`cut` commands (the `fluncle-studio-clip` cron).
RUN arch="$(uname -m)" \
  && case "$arch" in \
       aarch64|arm64) cpu="arm64" ;; \
       x86_64|amd64)  cpu="x64" ;; \
       *) echo "unsupported arch for the fluncle binary: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/mauricekleine/fluncle/releases/download/v0.111.0/fluncle-linux-${cpu}" \
       -o /usr/local/bin/fluncle \
  && chmod 755 /usr/local/bin/fluncle

# GitHub CLI — the nightly-audit agents (audit-timer/) drive PRs through it (gh pr create/merge/
# comment) with GH_TOKEN. Pinned single-binary from the release tarball, like yt-dlp; MANUAL-watch
# tier (low-churn, backward-compatible) — NOT in hermes-pin-drift's hourly auto-bump, bumped
# deliberately, with the nightly Security audit as the staleness backstop. pin-watch's pre-smoke
# does `gh --version` after any rebuild so a broken bump rolls back.
RUN arch="$(uname -m)" \
  && case "$arch" in \
       aarch64|arm64) gharch="arm64" ;; \
       x86_64|amd64)  gharch="amd64" ;; \
       *) echo "unsupported arch for gh: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_${gharch}.tar.gz" \
       -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 755 "/tmp/gh_2.96.0_linux_${gharch}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/gh_2.96.0_linux_${gharch}"

# Bake the on-box sweep scripts so they ride the image (auto-update via pin-watch) and are
# read straight from here by the host-timer units — no docker cp, no /opt/data projection.
# Exclude the co-located tests and clip-drip-sweep.sh (a deliberately un-deployed cron). Keep
# provision-rave-03.sh — it is NOT operator-only: render-conductor.sh execs it as a sibling
# (`$SCRIPT_DIR/provision-rave-03.sh`) on a render-box cold start, so the render timer needs it
# baked here too. World-readable + exec so the non-root hermes cron user runs them.
COPY docs/agents/hermes/scripts/ /opt/hermes-scripts/
RUN rm -f /opt/hermes-scripts/*.test.ts \
          /opt/hermes-scripts/clip-drip-sweep.sh \
 && chmod -R a+rX /opt/hermes-scripts \
 && chmod +x /opt/hermes-scripts/*.sh /opt/hermes-scripts/*.py

# Oxanium SemiBold for the Fluncle Studio clip cut — the COORDINATE face. The `admin clips
# cut` brand frame draws the `fluncle://<logId>` coordinate in Oxanium (DESIGN.md "One
# Voice": Oxanium for marks/numerals; the title uses the DejaVu sans above) with ffmpeg's
# drawtext, which goes through freetype — freetype reads only .ttf/.otf, never the app's
# .woff2. Bake the static TTF (OFL, redistributable; instanced at weight 600 from the repo's
# Oxanium) at BOX_CLIP_FONT_FILE so the cut resolves it with NO manual step: apps/cli/src/
# commands/clips.ts `resolveClipFontFile()` defaults to /opt/fonts/Oxanium-SemiBold.ttf when
# CLIP_FONT_FILE is unset and the file exists. COPY needs the repo root as build context
# (see the header). World-readable (a+rX) so the non-root cron user can read it.
COPY apps/cli/assets/fonts/Oxanium-SemiBold.ttf /opt/fonts/Oxanium-SemiBold.ttf
RUN chmod -R a+rX /opt/fonts

# Claude Code — the `fluncle-observation` `--no-agent` cron's ONE agentic step shells
# out to `claude -p` to author the recovered-audio observation script in Fluncle's
# voice (subscription auth via CLAUDE_CODE_OAUTH_TOKEN at run time; zero OpenRouter
# tokens). Pinned for reproducible rebuilds (the version line busts the layer cache on
# a bump) — matches the box's proven spike version. Bump deliberately, never float
# `latest` (Hermes is pre-1.0; pin the whole toolchain). `npm -g` lands in
# /usr/local/lib + a /usr/local/bin/claude symlink, both world-accessible, so the
# NON-root cron user can exec it (same world-readable property the `fluncle` CLI relies
# on). Bump lever: this version line.
RUN npm install -g @anthropic-ai/claude-code@2.1.206

# ALL local Fluncle skills, baked for Claude Code so every box `claude -p` discovers
# them without a per-run `skills:install`: the voice crons load `copywriting-fluncle`
# (note/observe/newsletter authoring), and the nightly audit + reviewer agents lean on
# the operator skills (fluncle-hermes-operator, fluncle-surfaces, fluncle-audit-operator,
# fluncle-maintenance, taste, …). CLAUDE DISCOVERS SKILLS UNDER ITS CONFIG DIR
# (<CLAUDE_CONFIG_DIR>/skills/<name>/, default ~/.claude/skills/). The `--no-agent`
# cron runner execs as a NON-root user whose HOME is not knowable at build time, so
# rather than guess that user's ~/.claude we pin the config dir to a world-readable
# baked path via CLAUDE_CONFIG_DIR=/opt/claude and drop the whole set at
# /opt/claude/skills/<name>. This makes skill discovery independent of the cron user's
# identity/HOME and survives every rebuild (baked, not host-mounted). The dir is
# world-traversable (755) and made writable (1777, sticky) because Claude Code writes
# session/state files under the config dir at run — the non-root cron user must be able
# to create them without owning /opt/claude; the skill files themselves stay root-owned
# + read-only. The whole tree is small (~1 MB), so baking all of packages/skills is
# drift-proof — a new skill needs no Dockerfile change. COPY needs the repo root as the
# build context (see the header). Update a skill the same way as any image change: edit
# it in the repo (packages/skills/<name>), rebuild, restart.
ENV CLAUDE_CONFIG_DIR=/opt/claude
COPY packages/skills /opt/claude/skills
RUN chmod -R a+rX /opt/claude/skills \
  && chmod 1777 /opt/claude

# Bake the enrichment DSP skill (analyze-track.ts + its helpers) so the enrich sweep's analyzer
# rides the image + auto-updates from main, instead of being hand-`docker cp`'d to /opt/data/skills.
COPY packages/skills/fluncle-track-enrichment/scripts /opt/hermes-skills/fluncle-track-enrichment/scripts
RUN chmod -R a+rX /opt/hermes-skills
