# Bump procedure — edit the pin, merge it, then ship it to the box

A bump is two halves: **the repo edit** (committed, reviewed in git, CI-gated) and **the deploy** (the running box catches up). The routine now does **both** for a clearly-safe bump — it merges the green PR, and for a baked Dockerfile pin it also rebuilds + redeploys + smoke-tests the box, **rolling back if the smoke fails**. The box mechanics belong to the `fluncle-hermes-operator` skill; this routine drives them. It still **brakes** (reports, never ships) on anything risky — see [safety-doctrine.md](safety-doctrine.md).

## The two halves, and what validates each

| Half           | Validated by                                                                                       | What ships it                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Repo edit**  | the CI deploy-gate (`format:check` + `lint` + `typecheck` + `test`) + gitleaks                     | merging the green PR to `main`.                                                                                                     |
| **Box deploy** | the **post-rebuild smoke test** (CI never rebuilds the image — this is the validation it can't do) | rebuilding the image from the merged `main`, redeploying the container, smoke-testing, with rollback to the previous image on fail. |

Two of the six inventory items (`package.json` `packageManager`, the workflow `bun-version:` + the Actions SHA-pins) are **fully** repo-side — they ship the moment the PR merges; **no box step**. The other half (the Dockerfile `FROM` / `npm -g` pins) only reaches the box on a **rebuild** — and the rebuild is now the routine's, gated by the smoke test.

## The flow for a clearly-safe bump (repo → merge → box)

1. **Edit the pin in place** on a branch — the inventory tells you the exact line/marker per item. For bun, edit all three places in one commit.
2. **Run the repo-side gate locally**, then **open a PR** with the drift table, the per-item safety call, and (for a Dockerfile edit) the note that the box rebuild + smoke-test will follow the merge.
3. **Wait for the PR's CI to go green** (Quality Checks + gitleaks + the Cloudflare build). A red check → **do not merge**; report and leave the PR for a human.
4. **Merge** the green PR (`gh pr merge --squash --admin --delete-branch`).
5. **If a baked Dockerfile pin changed, ship it to the box** (the deploy half, below). Otherwise you're done — the repo-side change is live on merge.

## The deploy half (driven, with a rollback rail — mechanics NOT inlined here)

The exact build context, the `docker build`/`docker run` invocation, the env-file + secret placement, the cron user, and the smoke-test checklist are the **`fluncle-hermes-operator`** skill's, and the secret-bearing steps live in **the Hermes ops runbook note in 1Password**. The routine reads those at run time. The **shape** it follows (so the doctrine is explicit without inlining commands):

1. **Make it reversible first.** Capture the running container's run-config (`docker inspect`) and **keep the previous image** (tag it / don't prune it). Nothing below is allowed to start until the old image is preserved.
2. **Single-flight.** If a rebuild/redeploy is already in progress, stop — never run two.
3. **Rebuild** the image from the repo root against the merged `docs/agents/hermes/Dockerfile` (build context = repo root so the baked skill is reachable).
4. **Redeploy** — stop the old container, run the new image with the captured config + the env-file repopulated from the ops note, restart.
5. **Smoke-test** the verify checklist: `fluncle version` is the new pin; an agent-tier read returns `{ok:true}`; a publish-class command is refused 403; for the render path, `box status` → authed; `dig` answers; `hermes cron list` shows the roster.
6. **Gate on the smoke:**
   - **Pass** → shipped. Report it.
   - **Fail** → **roll back**: stop the new container, restart the **previous image**, confirm the smoke checklist passes on it. The PR is already merged, so report loudly that the box stayed on the prior CLI pending a human, and leave a follow-up note.
   - **Rollback fails** (the worst case) → **stop**. Fire the loudest alert available (the operator Discord webhook from the ops note); do not keep retrying. A human takes it from here.

The box must **never** be left on a broken build. A clean rebuild whose smoke test passes is the only "shipped" state; everything else ends on the previous image.

## When the routine does NOT do the deploy half

- **A BRAKE item** never reaches merge, so it never reaches the box — it's a report.
- **A base-image bump** is always a BRAKE: report the newer tag, let the operator pull it (the rebuild's failure mode there is the whole gateway, too coarse and too consequential to take unattended).
- **box.ascii** is unpinnable; the routine re-verifies the conductor as part of the smoke test after a rebuild it did for another reason, but never bumps it.

## Public-repo rule (applies to every file in this skill)

**Never** inline in any committed file here: host names, IPs, secret values, `op://` paths, box SSH/`docker`/`box` commands, or local `/Users/...` filesystem paths. The operator's secret-bearing commands stay in the 1Password ops note + the `fluncle-hermes-operator` skill; the committed docs and this skill stay at the architecture / procedure level. (Same rule the `fluncle-hermes-operator` skill and the cron README hold.)
