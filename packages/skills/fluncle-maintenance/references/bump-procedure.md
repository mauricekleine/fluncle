# Bump procedure — edit the pin, then ship it

A bump is two halves: **the repo edit** (committed, reviewed in git) and **the deploy** (the running box catches up). This skill — and the routine — only ever do the first half and open a PR. The second half (rebuild + redeploy + smoke-test) is an **operator** step, because it touches the box, spends a rebuild, and needs the box secrets.

## The split: what the routine does vs what the operator does

| Half          | Who                           | What                                                                                                                                                            |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo edit** | the routine (or you, by hand) | Edit the pin in the committed file, commit on a branch, open a PR. The CI deploy-gate (`format:check` + `lint` + `typecheck` + `test`) validates the repo side. |
| **Deploy**    | the operator only             | Rebuild the Hermes image from the edited Dockerfile, redeploy to the box, run the smoke tests. Routine **never** does this.                                     |

Two of the six inventory items (`package.json` `packageManager`, the workflow `bun-version:` + the Actions SHA-pins) are **fully** repo-side — they ship when the PR merges to `main` and CI/the Cloudflare build picks them up, no box step. The other half (the Dockerfile `FROM` / `npm -g` pins) only reaches the box on a **rebuild**, which is the operator follow-up. A PR that edits a Dockerfile pin must say so in its body: _"rebuild + redeploy is an operator follow-up; the repo edit is validated by CI but the box still runs the old pin until rebuilt."_

## The repo-edit half (what a routine PR contains)

1. **Edit the pin in place** — the inventory tells you the exact line/marker per item. For bun, edit all three places in the same commit.
2. **Commit on a branch** (never push to `main` from the routine — open a PR; see the automation prompt). Conventional commit, e.g. `chore(deps): bump claude-code CLI pin 2.1.186 → 2.1.187` or `chore(ci): SHA-pin GitHub Actions (deepsec finding)`.
3. **Open a PR** with: the drift table (item, old pin, new pin, drift class), the safety call per item, and — for any Dockerfile edit — the explicit "operator rebuild follow-up" note. Let the CI deploy-gate run.
4. **Stop.** Do not merge (the orchestrating session / operator merges), do not touch the box.

## The deploy half (operator — referenced, NOT inlined here)

The exact build context, the `docker build`/`docker run` invocation, the env-file + secret placement, the cron user, and the smoke tests are **operator material**. They are **not** reproduced in this public skill. They live in:

- **The Hermes ops runbook note in 1Password** — the canonical operator recipe (build context, the exact build/run commands, the secrets, the smoke-test checklist). This is where the operator works from.
- **`docs/agents/hermes/cron/README.md`** — the in-repo, architecture-level runbook for the crons and the render conductor (what each pin powers, the rebuild pre-reqs at the procedure level, the verify checklist). Public-safe; routes to the ops note for the secret-bearing steps.
- **The `fluncle-hermes-operator` skill** — the operator's map for _which lever_ a change pulls and the change → ship → verify loop. The "bump the upstream pin / the bundled `fluncle` CLI / the Claude Code CLI" row says: **rebuild the image (from the repo root, `-f docs/agents/hermes/Dockerfile`) + restart + smoke test.** That skill owns the box mechanics; this one routes to it.

The shape of the operator deploy (so the routine's PR note is accurate, without inlining commands):

1. **Rebuild** the image from the repo root against the edited `docs/agents/hermes/Dockerfile` (the build context is the repo root so the baked skill is reachable).
2. **Redeploy + restart** the container on the box.
3. **Smoke-test** — the verify checklist in `docs/agents/hermes/cron/README.md` (CLI present and the right version; an agent-allowed read returns `{ok:true}`; a publish-class command is refused 403; for a base bump, the gateway starts above the model-context floor; for a render-path bump, `box status` → authed and a conductor dry-run).

## Public-repo rule (applies to every file in this skill)

**Never** inline in any committed file here: host names, IPs, secret values, `op://` paths, box SSH/`docker`/`box` commands, or local `/Users/...` filesystem paths. The operator's secret-bearing commands stay in the 1Password ops note. The committed docs and this skill stay at the architecture / procedure level. (Same rule the `fluncle-hermes-operator` skill and the cron README hold.)

## After the deploy (operator confirms)

A bump is "done" only once the operator has rebuilt, redeployed, and the smoke test passed — and, for the render path, re-verified box.ascii (it self-updates, so a rebuild is a natural moment to confirm the conductor still authenticates and renders). The routine's job ends at the green PR; closing the loop on the box is the operator's, and the PR should say so.
