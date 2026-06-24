# Version inventory — the drift surface

Every pinned/baked version in Fluncle's runtime supply chain, with where it lives, how to read the current pin, the one-liner that checks latest, and how to bump it. Run the sweep top-to-bottom. **Line numbers are a hint, not a contract** — files drift; each pin carries a stable comment marker (quoted below) that locates it even if the line moved. When a line number is wrong, `grep` the marker.

All commands assume the repo root as the working directory. The "check latest" one-liners are read-only (npm/curl) — safe to run on any tick.

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

- **How to bump:** edit the `FROM` tag → **rebuild the image + redeploy + smoke-test** (operator step — see `bump-procedure.md`). The version line also busts the Docker layer cache.
- **Safety:** **PULL THE BRAKE — always report, never auto-apply.** Pre-1.0; a base bump can change the runtime or drop the gateway below the model-context floor, and the only validation is a box rebuild + smoke test this routine cannot run. Report the available tag and let the operator decide. Periodically the operator _should_ take a base bump for upstream security patches — surface it, do not apply it.

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

- **How to bump:** change the version in **all** of: the Dockerfile installer line (`bun-v<new>`), `package.json` `packageManager` (`bun@<new>`), and every workflow `bun-version:`. Then the Dockerfile change ships via image rebuild; the `package.json` + workflow changes ship via the PR's CI deploy-gate and merge to `main`.
- **Safety:** a **patch/minor** that the CI deploy-gate accepts is safe to apply (it is the same interpreter CI runs). A **major** bun bump = **brake** (toolchain-wide behaviour change). Note that the image-rebuild half is still an operator follow-up; the routine can land the repo-side `package.json` + workflow change and flag the Dockerfile line for the rebuild.

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

- **How to bump:** edit the `fluncle@<version>` → rebuild + redeploy. The version line busts the layer cache. (This is Fluncle's own CLI, released by the repo's `cli-release.yml`; it carries the renamed Convention-B surface + admin commands the crons call.)
- **Safety:** a **patch/minor** is safe to auto-apply — it is first-party, and a stale CLI on the box just lacks a recent command. Still, **the bump ships only on an image rebuild** (operator follow-up); the PR lands the Dockerfile edit and flags the rebuild. A **major** = brake (a renamed/removed command could break a cron).

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

- **How to bump:** edit `@anthropic-ai/claude-code@<version>` → rebuild + redeploy. This is the `claude -p` binary the observation cron's one agentic step shells out to (subscription auth at run time; zero OpenRouter tokens). Never float `latest` — the Hermes toolchain is pinned whole.
- **Safety:** a **patch/minor** is safe to auto-apply (it is the agent CLI, not the model or the auth; the deploy-gate covers the repo side, and a patch rarely changes the `claude -p` contract). The bump still ships on an image rebuild (operator follow-up). A **major** = brake (the `-p` / skills-discovery contract could change). Anything touching the **auth token shape** = brake regardless of version.

---

## 5. box.ascii CLI (the render box transport) — UNPINNABLE, RE-VERIFY ONLY

- **File:** `docs/agents/hermes/Dockerfile` (~line 65), the `box.ascii.dev/install` block.
- **Marker:** `curl -fsSL https://box.ascii.dev/install` (the comment says `box.ascii is pre-1.0 and its installer offers no version pin … this is the one image dependency not version-pinned … Re-verify the conductor after a base rebuild.`)
- **Current pin:** **none.** The installer tracks the `ascii-prod` channel and the CLI self-updates. There is no version to read and nothing to bump.
- **Check latest:** N/A — not pinnable. Do not try to pin it; that is by design.
- **Action on a sweep:** there is **no bump**. The only maintenance is to **re-verify the render conductor after the operator rebuilds the base image** (a `box status` → authed, then a conductor dry-run). That verification is part of the operator's rebuild smoke-test, not a routine auto-apply. If a sweep finds nothing else to do, box.ascii contributes a one-line "unpinnable, re-verify post-rebuild" note and nothing more.
- **Safety:** always **brake** in the sense that the routine never acts on it. It is the operator's post-rebuild check.

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
- **Renovate recommendation:** the `.deepsec` finding recommends a bot (Renovate or Dependabot) to keep SHA-pinned actions bumped. The repo has **no** `renovate.json`/`dependabot.yml` today. Adding one is a reasonable, low-risk follow-up the routine may include in its PR (Renovate's `helpers:pinGitHubActionDigests` preset pins-and-tracks) — but call it out in the PR body as a config addition, not silently.
- **Safety:** **SHA-pinning at the current major is SAFE to auto-apply** — it changes no behaviour (same commit the tag resolves to today), and the CI deploy-gate/PR run proves the workflow still parses and runs. Bumping an action to a **new major** = brake (report it). Adding a Renovate config is safe but should be named explicitly in the PR.

---

## Quick reference table

| #   | Item                | File (marker)                                                                     | Current pin (read)          | Check latest                                 | Auto-apply?                       |
| --- | ------------------- | --------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------- | --------------------------------- |
| 1   | Hermes base image   | `Dockerfile` `FROM nousresearch/hermes-agent:`                                    | `grep '^FROM nousresearch'` | Docker Hub tags API                          | **Never** (pre-1.0)               |
| 2   | bun (×3)            | `Dockerfile` `bun-v` + `package.json` `packageManager` + workflows `bun-version:` | the three greps above       | bun GH `releases/latest`                     | patch/minor yes, major brake      |
| 3   | `fluncle` CLI       | `Dockerfile` `npm install -g fluncle@`                                            | `grep 'fluncle@'`           | `npm view fluncle version`                   | patch/minor yes, major brake      |
| 4   | Claude Code CLI     | `Dockerfile` `@anthropic-ai/claude-code@`                                         | `grep 'claude-code@'`       | `npm view @anthropic-ai/claude-code version` | patch/minor yes, major/auth brake |
| 5   | box.ascii CLI       | `Dockerfile` `box.ascii.dev/install`                                              | unpinned                    | N/A                                          | **Never** (re-verify only)        |
| 6   | GitHub Actions tags | `.github/workflows/*.yml` `uses: …@vN`                                            | `grep 'uses:.*@'`           | `gh api …/git/refs/tags/<tag>`               | **SHA-pin at current major: yes** |
