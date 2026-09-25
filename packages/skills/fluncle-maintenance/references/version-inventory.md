# Version inventory — the drift surface

Every pinned/baked version in Fluncle's runtime supply chain, with where it lives, how to read the current pin, the one-liner that checks latest, and how to bump it. Run the sweep top-to-bottom. **Line numbers are a hint, not a contract** — files drift; each pin carries a stable comment marker (quoted below) that locates it even if the line moved. When a line number is wrong, `grep` the marker.

All commands assume the repo root as the working directory. The "check latest" one-liners are read-only (npm/curl) — safe to run on any tick.

**Automation covers most of this.** `.github/workflows/hermes-pin-drift.yml` (the script `.github/scripts/hermes-pin-drift.sh`) sweeps item **1** (the `oven/bun` base = bun), items **3–4** (the `fluncle` CLI, the Claude Code CLI), and item **7** (yt-dlp) on every `fluncle` release + hourly, and opens a PR for a safe bump (a major is reported); **Renovate** (`renovate.json`) owns item **6** (the Actions digests); items **2**, **5**, **8**, and **9** (node, boat.dev, uv, gh) are pinned but manual-watch. This inventory stays the source of truth the workflow encodes and the operator's runbook for the brakes it reports.

**A pin absent from this inventory is a pin nobody watches.** Every baked binary needs a row here. Item-level failures (e.g. `ytDlpFailures`) do not flip a run's verdict, so an unlisted pin that falls behind fails silently while each tick reports healthy.

---

## 1. bun — THE BASE IMAGE, TWO PLACES (auto-bumped same-major)

The image is built `FROM oven/bun:<ver>-debian@sha256:<digest>` (Debian trixie), so the base image tag IS the box's bun pin. The repo declares the same version as its `packageManager`, and every workflow reads bun from there (`oven-sh/setup-bun` with `bun-version-file: package.json`), so CI follows automatically.

- **Files + markers:**
  - `docs/agents/hermes/Dockerfile`: the `FROM oven/bun:<ver>-debian@sha256:…` line — the tag and the digest move together.
  - `package.json` (root): `"packageManager": "bun@<version>"`.
- **Current pins:**

  ```bash
  grep -n '^FROM oven/bun:' docs/agents/hermes/Dockerfile
  grep -n '"packageManager"' package.json
  grep -rn 'bun-version' .github/workflows/   # every hit should be bun-version-file: package.json
  ```

  The two versions should match. If they already disagree, or a workflow carries a literal `bun-version:`, that drift itself is worth reporting.

- **Check latest** (bun's GitHub releases — tags are `bun-vX.Y.Z` — and whether Docker Hub has the matching image yet):

  ```bash
  curl -fsSL https://api.github.com/repos/oven-sh/bun/releases/latest \
    | grep -m1 '"tag_name"' | sed 's/.*"bun-v//;s/".*//'
  curl -fsSL "https://hub.docker.com/v2/repositories/oven/bun/tags/<ver>-debian" | jq -r .digest
  ```

- **How to bump:** don't, by hand — `hermes-pin-drift.sh` rewrites the `FROM` tag + its re-resolved digest and `packageManager` in one PR. A bun release whose `-debian` image is not on Docker Hub yet waits for the next run. The `package.json` change ships on merge; the base change ships via the box's `fluncle-pin-watch` self-deploy (the Dockerfile is part of its baked-content fingerprint).
- **Safety:** a **patch/minor** is safe to ship (it is the same interpreter CI runs, and pin-watch pre-smokes the rebuilt image before the swap, rolling back on failure). A **major** = **brake**: it is both a toolchain-wide behaviour change and a new base image under every sweep.

---

## 2. node + npm (copied from the node image) — PINNED, MANUAL-WATCH TIER

- **File:** `docs/agents/hermes/Dockerfile`, the two `COPY --from=node:<ver>-trixie-slim@sha256:…` lines (node binary + `node_modules`, with the `npm`/`npx` symlinks after them).
- **Why it is there:** Claude Code installs through npm and runs on node, and the nightly audit drives the repo's node tooling. The trixie variant links against the same glibc as the base; the digest pins it like the base.
- **Current pin:** `grep -n 'COPY --from=node:' docs/agents/hermes/Dockerfile`.
- **Check latest:** the Node.js release schedule / `https://nodejs.org/dist/index.json` for the line in use, and the Docker Hub `node` tags for the matching `-trixie-slim` digest.
- **Action on a sweep:** **never bump automatically** — report drift. A bump edits both `COPY` lines (tag + digest together), and pin-watch's pre-smoke (`claude --version`) proves the copied runtime still starts before the swap.
- **Safety:** a same-major bump with its digest is a reviewed manual PR; a node major = **brake** (Claude Code and the audit tooling run on it).

---

## 3. `fluncle` CLI (baked)

- **File:** `docs/agents/hermes/Dockerfile` (the fluncle install block, ~line 83).
- **Marker:** `releases/download/v<version>/fluncle-linux-` — the box installs the **standalone bun-compiled binary**, NOT the `npm -g` thin client. The Bun-runtime commands (clip cut, media uploads — `Bun.spawn`/`Bun.file`) only run on the binary; the npm package's `#!/usr/bin/env node` shebang makes them throw "Bun is not defined". The binary embeds bun, so every command works on the box.
- **Current pin:**

  ```bash
  grep -n 'releases/download/v.*/fluncle-' docs/agents/hermes/Dockerfile
  ```

- **Check latest:**

  ```bash
  npm view fluncle version   # the npm thin client + the binary share one version (cli-release.yml)
  ```

- **How to bump:** edit the `releases/download/v<version>/` URL in the install block → open a PR → merge when CI green. The version busts the layer cache, and the on-box `fluncle-pin-watch` timer picks it up: rebuild → pre-smoke (`fluncle version` == the pin) → swap → auto-rollback. (Fluncle's own CLI, released by `cli-release.yml`, which publishes the npm thin client AND the standalone binaries at one version; the binary carries the Convention-B surface + the admin commands the crons call.)
- **Safety:** a **patch/minor** is safe to ship — it is first-party, and a stale CLI on the box just lacks a recent command. The merge triggers the pin-watch self-deploy (pre-smoke-validated, auto-rollback on fail). A **major** = brake (a renamed/removed command could break a cron).

---

## 4. Claude Code CLI (baked)

- **File:** `docs/agents/hermes/Dockerfile` (~line 90).
- **Marker:** `RUN npm install -g @anthropic-ai/claude-code@` (comment ends with `Bump lever: this version line.`)
- **Current pin:**

  ```bash
  grep -n 'npm install -g @anthropic-ai/claude-code@' docs/agents/hermes/Dockerfile
  ```

- **Check latest:**

  ```bash
  npm view @anthropic-ai/claude-code version
  ```

- **How to bump:** edit `@anthropic-ai/claude-code@<version>` → open a PR → merge when CI green. The on-box `fluncle-pin-watch` timer then rebuilds, pre-smokes (including an agent-tier `{ok:true}` check), and auto-rolls-back on any failure. This is the `claude -p` binary the observation cron's one agentic step shells out to (subscription auth at run time; zero OpenRouter tokens). Never float `latest` — the box toolchain is pinned whole.
- **Safety:** a **patch/minor** is safe to ship (it is the agent CLI, not the model or the auth; a patch rarely changes the `claude -p` contract). The deploy-gate can't validate a baked pin; the pin-watch pre-smoke validates it on the box before the live container is touched. A **major** = brake (the `-p` / skills-discovery contract could change). Anything touching the **auth token shape** = brake regardless of version.

---

## 5. boat.dev CLI (the render box transport) — PINNED, MANUAL-WATCH TIER

- **File:** `docs/agents/hermes/Dockerfile`, the `boat-cli-v<ver>` install block.
- **Marker:** `releases/download/boat-cli-v<ver>/boat-linux-` — an arch-aware release binary installed straight to `/usr/local/bin/boat`, checksum-verified against the release's published `SHA256SUMS` and smoked at bake time (`boat --version` must report the pin).
- **Current pin:** `grep 'boat-cli-v' docs/agents/hermes/Dockerfile`.
- **Why pinned rather than installed:** the vendor's `boat.dev/install` script tracks whatever it currently ships and ends in an interactive `onboard` no build can answer. A pin also stops a self-updating CLI from changing the conductor's verbs under it — but only together with the global `--no-update` every conductor call passes, because the binary still checks for a newer release on each run.
- **Check latest:** the vendor's release list (`ariana-dot-dev/agent-server`, tags `boat-cli-v*`). The plain `boat-cli-vX.Y.Z` tags are the prod releases; a suffixed tag (`-staging1`, `-amsterdam1`, …) is a region or staging build and is not the pin. Read it; do not auto-apply.
- **Action on a sweep:** **never bump automatically** — MANUAL-watch tier like gh, deliberately outside `hermes-pin-drift.sh`. Report drift, and keep the standing note that the conductor is re-verified after a rebuild (`render-conductor.sh --preflight` — it logs in, lists, and prints the pick without touching a box) — operator / `fluncle-healthcheck` work, NOT the pin-watch post-swap smoke (that smoke is only `fluncle version` + container-running).
- **Safety:** always **brake**. The CLI's verbs and their blocking/non-blocking behaviour are the conductor's contract (`login`/`list`/`new`/`ssh`/`scp`/`resume`/`stop`/`extend`, the restoring retry code, and `resume`'s readiness wait), so a bump can silently re-shape the render path. A bump ships as its own PR with `render-conductor.sh` + `provision-rave-03.sh` + their tests re-read, a `--preflight` run on the box, and one attended render behind it.

---

## 6. GitHub Actions pins — AXIS COMPLETE, Renovate owns it

Every action in every workflow is SHA-pinned with a trailing version comment, and Renovate maintains the digests. Do not hand-resolve tags to digests.

`renovate.json` (repo root) configures the Renovate GitHub App scoped to the `github-actions` manager with the `helpers:pinGitHubActionDigests` preset: it SHA-pins any newly-added action and refreshes each digest (same-major) as the action ships updates, while a new major waits for dependency-dashboard approval. The config is **inert until the Renovate app is installed** on the repo.

- **Verify the axis still holds** — every `uses:` should carry a 40-char SHA plus a `# vN` comment. A bare `@vN` is an action someone added by hand, and pinning that one at its current major is the only fix this item still asks for.

  ```bash
  grep -rn 'uses: ' .github/workflows/
  ```

- **Verify Renovate is actually flowing** — an installed-but-silent app looks exactly like an up-to-date repo, so check for its PRs rather than assuming:

  ```bash
  gh pr list --author 'app/renovate' --state all --limit 10
  ```

- **Safety:** pinning a stray action at its current major is SAFE to ship — it changes no behaviour (the same commit the tag resolves to today), and the CI run proves the workflow still parses. Bumping an action to a **new major** = brake (report it). Adding a Renovate config is safe but should be named explicitly in the PR.

---

## 7. yt-dlp (the capture fetcher) — AUTO-BUMPED, CALENDAR-VERSIONED

- **File:** `docs/agents/hermes/Dockerfile`, the early `yt-dlp` layer.
- **Marker:** `curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/<ver>/yt-dlp_linux`
- **Current pin:**

  ```bash
  grep -o 'yt-dlp/releases/download/[0-9.]*' docs/agents/hermes/Dockerfile
  ```

- **Check latest:**

  ```bash
  curl -fsSL https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest | jq -r .tag_name
  ```

- **How to bump:** don't, by hand — `hermes-pin-drift.sh` opens the PR. The on-box `fluncle-pin-watch` timer rebakes on merge.
- **Why it is auto-bumped rather than braked:** this is the binary `fluncle-capture` downloads audio with, and **staleness is its failure mode**. YouTube changes its player without notice; a yt-dlp that cannot follow fails every download. Holding a bump for review is therefore strictly more dangerous than taking it, which inverts the usual doctrine — so yt-dlp ships on any newer version.
- **Why the major brake does not apply:** yt-dlp is calendar-versioned (`2026.08.19`). The brake compares leading components, which for a date means it would fire every January on an ordinary release and stall the fix through the exact window a stale pin hurts most. The `calendar` flag on `assess` skips it.
- **Safety:** the pin-watch pre-smoke validates the rebuilt image before the live container is swapped, and rolls back on failure. If a bump ever does break capture, the symptom is `ytDlpFailures` on the `fluncle-capture` rows in the run ledger — **not** a red tick, so read the counter, not the verdict.

---

## 8. uv (the MuQ Python installer) — PINNED, MANUAL-WATCH TIER

- **File:** `docs/agents/hermes/Dockerfile`, `COPY --from=ghcr.io/astral-sh/uv:<ver>@sha256:… /uv /uvx /usr/local/bin/`.
- **Why it is there:** it installs the standalone Python the MuQ venv needs (Debian trixie's apt Python is newer than `muq` supports) and builds that venv.
- **Current pin:** `grep -n 'astral-sh/uv:' docs/agents/hermes/Dockerfile`.
- **Check latest:** `curl -fsSL https://api.github.com/repos/astral-sh/uv/releases/latest | jq -r .tag_name`, then the matching `ghcr.io/astral-sh/uv:<ver>` digest.
- **Action on a sweep:** report drift; bump tag + digest together by hand. pin-watch's embed/cluster import pre-smoke proves the venv still resolves after a rebuild.
- **Safety:** build-time only (nothing runs `uv` at sweep time), so a same-major bump is low-risk but still a reviewed manual PR; a major = **brake**.

---

## 9. gh (the audit PR driver) — PINNED, MANUAL-WATCH TIER

- **File:** `docs/agents/hermes/Dockerfile`, the `github.com/cli/cli/releases/download/v<ver>/gh_<ver>_linux_` install block.
- **Current pin:** `grep -o 'cli/cli/releases/download/v[0-9.]*' docs/agents/hermes/Dockerfile`.
- **Check latest:** `curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name`.
- **Action on a sweep:** report drift; bump by hand (the version appears several times in the block — move every occurrence). pin-watch's pre-smoke runs `gh --version` after any rebuild.
- **Safety:** low-churn and backward-compatible, with the nightly Security audit as the staleness backstop; a major = **brake**.

---

## Quick reference table

| #   | Item                | File (marker)                                                                       | Current pin (read)             | Check latest                                      | Ship end-to-end?                  |
| --- | ------------------- | ----------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------- | --------------------------------- |
| 1   | bun base image      | `Dockerfile` `FROM oven/bun:<ver>-debian@sha256:` + `package.json` `packageManager` | `grep '^FROM oven/bun'`        | bun GH `releases/latest` + Docker Hub tag         | patch/minor yes, major brake      |
| 2   | node + npm          | `Dockerfile` `COPY --from=node:<ver>-trixie-slim@sha256:`                           | `grep 'COPY --from=node:'`     | nodejs.org dist index + Docker Hub tag            | **Never** (manual watch)          |
| 3   | `fluncle` CLI       | `Dockerfile` `releases/download/v<ver>/fluncle-linux-` (standalone binary)          | `grep 'download/v.*/fluncle-'` | `npm view fluncle version`                        | patch/minor yes, major brake      |
| 4   | Claude Code CLI     | `Dockerfile` `@anthropic-ai/claude-code@`                                           | `grep 'claude-code@'`          | `npm view @anthropic-ai/claude-code version`      | patch/minor yes, major/auth brake |
| 5   | boat.dev CLI        | `Dockerfile` `releases/download/boat-cli-v<ver>/boat-linux-`                        | `grep 'boat-cli-v'`            | vendor release list (`boat-cli-v*` tags)          | **Never** (manual watch)          |
| 6   | GitHub Actions pins | `.github/workflows/*.yml` `uses: …@<sha> # vN`                                      | `grep 'uses:.*@'`              | Renovate PRs (`gh pr list --author app/renovate`) | **Renovate (auto-pins + tracks)** |
| 7   | yt-dlp              | `Dockerfile` `yt-dlp/releases/download/<ver>/yt-dlp_linux`                          | `grep 'yt-dlp/releases/down'`  | yt-dlp GH `releases/latest`                       | **Always** (staleness = outage)   |
| 8   | uv                  | `Dockerfile` `COPY --from=ghcr.io/astral-sh/uv:<ver>@sha256:`                       | `grep 'astral-sh/uv:'`         | uv GH `releases/latest`                           | **Never** (manual watch)          |
| 9   | gh                  | `Dockerfile` `cli/cli/releases/download/v<ver>/gh_`                                 | `grep 'cli/cli/releases'`      | gh GH `releases/latest`                           | **Never** (manual watch)          |
