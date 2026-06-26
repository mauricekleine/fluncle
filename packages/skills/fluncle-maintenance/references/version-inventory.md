# Version inventory — the drift surface

Every pinned/baked version in Fluncle's runtime supply chain, with where it lives, how to read the current pin, the one-liner that checks latest, and how to bump it. Run the sweep top-to-bottom. **Line numbers are a hint, not a contract** — files drift; each pin carries a stable comment marker (quoted below) that locates it even if the line moved. When a line number is wrong, `grep` the marker.

All commands assume the repo root as the working directory. The "check latest" one-liners are read-only (npm/curl) — safe to run on any tick.

**Most of this is now automated.** `.github/workflows/hermes-pin-drift.yml` (the script `.github/scripts/hermes-pin-drift.sh`) sweeps items **2–4** (bun, the `fluncle` CLI, the Claude Code CLI) weekly and opens a PR for a same-major bump; **Renovate** (`renovate.json`) owns item **6** (the Actions digests); item **1** (base image) is report-only and item **5** (box.ascii) is unpinnable. This inventory stays the source of truth the workflow encodes and the operator's runbook for the brakes it reports.

---

## 1. Nous Research Hermes base image — PRE-1.0, BRAKE BY DEFAULT

- **File:** `docs/agents/hermes/Dockerfile`, the `FROM` line (~line 18).
- **Marker:** `FROM nousresearch/hermes-agent:`
- **Current pin:** read it —

  ```bash
  grep -n '^FROM nousresearch/hermes-agent:' docs/agents/hermes/Dockerfile
  ```

- **Check latest** (Docker Hub tags API, newest first):

  ```bash
  curl -fsSL "https://hub.docker.com/v2/repositories/nousresearch/hermes-agent/tags?page_size=20&ordering=last_updated" \
    | grep -oE '"name":"[^"]+"' | sed 's/"name":"//;s/"//' | head -20
  ```

  These are calendar-versioned (`vYYYY.M.D`). Compare the newest tag to the pin.

- **How to bump:** edit the `FROM` tag → open a PR → merge when CI green → the on-box `fluncle-pin-watch` timer self-deploys the rebuild (see `bump-procedure.md` and `docs/agents/hermes/pin-watch/`). The version line also busts the Docker layer cache.
- **Safety:** **PULL THE BRAKE — always report, never ship.** Pre-1.0; a base bump can change the runtime or drop the gateway below the model-context floor at startup. The base's failure mode is the **whole gateway**, not one probe — too coarse and too consequential to ship unattended even with the pin-watch pre-smoke safety net. Report the available tag and let the operator decide. Periodically the operator _should_ take a base bump for upstream security patches — surface it, do not apply it.

---

## 2. bun — ONE VERSION, THREE PLACES (keep in sync)

bun is baked into the image, declared as the repo's `packageManager`, and requested by the CI workflows. A bump must move **all** of them together or the box runs a different interpreter than CI/the repo.

- **Files + markers:**
  - `docs/agents/hermes/Dockerfile` (~line 41): the installer pin — marker `curl -fsSL https://bun.sh/install | bash -s "bun-v` and the comment `# Bun — pinned to the repo's toolchain (packageManager bun@…)`.
  - `package.json` (root): `"packageManager": "bun@<version>"`.
  - `.github/workflows/quality-checks.yml` and `.github/workflows/cli-release.yml`: each `oven-sh/setup-bun` step has a `bun-version: <version>`.
- **Current pins:** read them all at once —

  ```bash
  grep -n 'bun-v' docs/agents/hermes/Dockerfile
  grep -n '"packageManager"' package.json
  grep -rn 'bun-version:' .github/workflows/
  ```

  They should all match. If they already disagree, that drift itself is worth reporting.

- **Check latest** (bun's GitHub releases — tags are `bun-vX.Y.Z`):

  ```bash
  curl -fsSL https://api.github.com/repos/oven-sh/bun/releases/latest \
    | grep -m1 '"tag_name"' | sed 's/.*"bun-v//;s/".*//'
  ```

- **How to bump:** change the version in **all** of: the Dockerfile installer line (`bun-v<new>`), `package.json` `packageManager` (`bun@<new>`), and every workflow `bun-version:`. The Dockerfile change ships via the box's `fluncle-pin-watch` self-deploy after the PR merges; the `package.json` + workflow changes ship via the PR's CI deploy-gate and merge to `main`.
- **Safety:** a **patch/minor** that the CI deploy-gate accepts is safe to ship (it is the same interpreter CI runs). A **major** bun bump = **brake** (toolchain-wide behaviour change). The repo-side `package.json` + workflow change ships on merge; the baked Dockerfile line ships via pin-watch (rebuild → pre-smoke → auto-rollback on fail).

---

## 3. `fluncle` CLI (baked)

- **File:** `docs/agents/hermes/Dockerfile` (~line 79).
- **Marker:** `RUN npm install -g fluncle@` (comment ends with `Bump deliberately when a newer release is needed on the box.`)
- **Current pin:**

  ```bash
  grep -n 'npm install -g fluncle@' docs/agents/hermes/Dockerfile
  ```

- **Check latest:**

  ```bash
  npm view fluncle version
  ```

- **How to bump:** edit the `fluncle@<version>` line → open a PR → merge when CI green. The version line busts the layer cache, and the on-box `fluncle-pin-watch` timer picks it up: rebuild → pre-smoke → swap → auto-rollback. (This is Fluncle's own CLI, released by the repo's `cli-release.yml`; it carries the renamed Convention-B surface + admin commands the crons call.)
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

- **How to bump:** edit `@anthropic-ai/claude-code@<version>` → open a PR → merge when CI green. The on-box `fluncle-pin-watch` timer then rebuilds, pre-smokes (including an agent-tier `{ok:true}` check), and auto-rolls-back on any failure. This is the `claude -p` binary the observation cron's one agentic step shells out to (subscription auth at run time; zero OpenRouter tokens). Never float `latest` — the Hermes toolchain is pinned whole.
- **Safety:** a **patch/minor** is safe to ship (it is the agent CLI, not the model or the auth; a patch rarely changes the `claude -p` contract). The deploy-gate can't validate a baked pin; the pin-watch pre-smoke validates it on the box before the live container is touched. A **major** = brake (the `-p` / skills-discovery contract could change). Anything touching the **auth token shape** = brake regardless of version.

---

## 5. box.ascii CLI (the render box transport) — UNPINNABLE, RE-VERIFY ONLY

- **File:** `docs/agents/hermes/Dockerfile` (~line 65), the `box.ascii.dev/install` block.
- **Marker:** `curl -fsSL https://box.ascii.dev/install` (the comment says `box.ascii is pre-1.0 and its installer offers no version pin … this is the one image dependency not version-pinned … Re-verify the conductor after a base rebuild.`)
- **Current pin:** **none.** The installer tracks the `ascii-prod` channel and the CLI self-updates. There is no version to read and nothing to bump.
- **Check latest:** N/A — not pinnable. Do not try to pin it; that is by design.
- **Action on a sweep:** there is **no bump**. The only maintenance is to **re-verify the render conductor after a rebuild** (a `box status` → authed, then a conductor dry-run) — which the on-box pin-watch post-smoke already does whenever it rebuilds for another baked pin. If a sweep finds nothing else to do, box.ascii contributes a one-line "unpinnable, re-verify post-rebuild" note and nothing more.
- **Safety:** always **brake** in the sense that the routine never bumps it. The pin-watch post-smoke re-verifies the conductor as part of any rebuild it does; the routine itself never SSHes to the box to do so.

---

## 6. GitHub Actions mutable tags — SHA-PIN (the `.deepsec` finding)

The `.deepsec` scan (`.deepsec/data/fluncle/reports/`) flags every workflow action as pinned to a **mutable major-version tag** rather than a commit SHA — a supply-chain risk: a force-moved tag or a compromised upstream could run arbitrary code in CI. The highest-concern one is `oven-sh/setup-bun` in `cli-release.yml`, which runs in the OIDC-publishing job that mints the npm token + holds the Homebrew tap token.

- **Files + the flagged actions:**
  - `.github/workflows/quality-checks.yml`: `actions/checkout@v6`, `oven-sh/setup-bun@v2`, `actions/setup-go@v6`, `actions/cache@v5`.
  - `.github/workflows/cli-release.yml`: `actions/checkout@v6`, `oven-sh/setup-bun@v2`, `actions/setup-node@v5`.
- **List current refs:**

  ```bash
  grep -rnE 'uses: [^ ]+@' .github/workflows/
  ```

- **Resolve the commit SHA for the tag you already use** (so you pin the _same_ behaviour, not a new version):

  ```bash
  # Example for the tag in use; repeat per action+tag.
  gh api repos/actions/checkout/git/refs/tags/v6 --jq '.object.sha'
  gh api repos/oven-sh/setup-bun/git/refs/tags/v2 --jq '.object.sha'
  ```

  If the tag points at an annotated-tag object, dereference it: `gh api repos/<owner>/<repo>/git/tags/<sha> --jq '.object.sha'`.

- **How to apply (the SHA-pin):** replace `uses: actions/checkout@v6` with `uses: actions/checkout@<40-char-sha> # v6` (keep the version in a trailing comment so humans and bots can read it). Do this for each flagged action **at its current major** — you are hardening the reference, not upgrading the action.
- **Renovate owns this axis now.** `renovate.json` (repo root) configures the Renovate GitHub App scoped to the `github-actions` manager with the `helpers:pinGitHubActionDigests` preset — it SHA-pins each action and refreshes the digest (same-major) as the action ships updates; a new major waits for dependency-dashboard approval. The config is **inert until the Renovate app is installed** on the repo. A manual sweep no longer hand-SHA-pins the actions — instead, verify Renovate is installed and its PRs are flowing.
- **Safety:** **SHA-pinning at the current major is SAFE to auto-apply** — it changes no behaviour (same commit the tag resolves to today), and the CI deploy-gate/PR run proves the workflow still parses and runs. Bumping an action to a **new major** = brake (report it). Adding a Renovate config is safe but should be named explicitly in the PR.

---

## Quick reference table

| #   | Item                | File (marker)                                                                     | Current pin (read)          | Check latest                                 | Ship end-to-end?                  |
| --- | ------------------- | --------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------- | --------------------------------- |
| 1   | Hermes base image   | `Dockerfile` `FROM nousresearch/hermes-agent:`                                    | `grep '^FROM nousresearch'` | Docker Hub tags API                          | **Never** (pre-1.0)               |
| 2   | bun (×3)            | `Dockerfile` `bun-v` + `package.json` `packageManager` + workflows `bun-version:` | the three greps above       | bun GH `releases/latest`                     | patch/minor yes, major brake      |
| 3   | `fluncle` CLI       | `Dockerfile` `npm install -g fluncle@`                                            | `grep 'fluncle@'`           | `npm view fluncle version`                   | patch/minor yes, major brake      |
| 4   | Claude Code CLI     | `Dockerfile` `@anthropic-ai/claude-code@`                                         | `grep 'claude-code@'`       | `npm view @anthropic-ai/claude-code version` | patch/minor yes, major/auth brake |
| 5   | box.ascii CLI       | `Dockerfile` `box.ascii.dev/install`                                              | unpinned                    | N/A                                          | **Never** (re-verify only)        |
| 6   | GitHub Actions tags | `.github/workflows/*.yml` `uses: …@vN`                                            | `grep 'uses:.*@'`           | `gh api …/git/refs/tags/<tag>`               | **Renovate (auto-pins + tracks)** |
