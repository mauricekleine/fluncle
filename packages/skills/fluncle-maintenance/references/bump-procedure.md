# Bump procedure — edit the pin, merge it; the box self-deploys

A bump is two halves: **the repo edit** (committed, reviewed in git, CI-gated) and **the deploy** (the running box catches up). The routine does the first half — edit → PR → CI-green → merge. For a baked Dockerfile pin, the second half is the on-box `fluncle-pin-watch` timer's job (rave-02): it detects the new pin on `main`, rebuilds the image, pre-smokes it BEFORE touching the live container, swaps, post-smokes, and auto-rolls-back on any failure. The routine **never** SSHes, rebuilds, or touches the box. It still **brakes** (reports, never ships) on anything risky — see [safety-doctrine.md](safety-doctrine.md).

## The two halves, and what validates each

| Half           | Validated by                                                                                        | What ships it                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Repo edit**  | the CI deploy-gate (`format:check` + `lint` + `typecheck` + `test`) + gitleaks                      | merging the green PR to `main`.                                                                                             |
| **Box deploy** | the **pin-watch pre-smoke** (CI never rebuilds the image — pin-watch is the validation it can't do) | the on-box `fluncle-pin-watch` timer: rebuild → pre-smoke → swap → auto-rollback on fail (`docs/agents/hermes/pin-watch/`). |

Two of the six inventory items (`package.json` `packageManager`, the workflow `bun-version:` + the Actions SHA-pins) are **fully** repo-side — they ship the moment the PR merges; **no box step**. The other half (the Dockerfile `FROM` / `npm -g` pins) only reaches the box on a **rebuild** — and that rebuild is the on-box pin-watch timer's, not the routine's.

## The flow for a clearly-safe bump (edit → PR → merge)

1. **Edit the pin in place** on a branch — the inventory tells you the exact line/marker per item. For bun, edit all three places in one commit.
2. **Run the repo-side gate locally**, then **open a PR** with the drift table, the per-item safety call, and (for a Dockerfile edit) a note that the on-box `fluncle-pin-watch` timer will self-deploy it after the merge (`docs/agents/hermes/pin-watch/`).
3. **Wait for the PR's CI to go green** (Quality Checks + gitleaks + the Cloudflare build). A red check → **do not merge**; report and leave the PR for a human.
4. **Merge** the green PR (`gh pr merge --squash --admin --delete-branch`). That is the routine's delivery.
5. **If the merged change includes a baked Dockerfile pin** — you are done. The on-box `fluncle-pin-watch` timer (rave-02) detects the new pin on `main`, rebuilds the image, pre-smokes it (versions, an agent-tier `{ok:true}`, a publish-class 403) BEFORE touching the live container, swaps, post-smokes, and **auto-rolls-back on any failure**, Discord-alerting on deploy or rollback. The routine never SSHes, never runs `docker`, never touches `op`. If only repo-side pins changed, you are also done — they shipped on the merge.

## The box's self-deploy (the pin-watch timer — for reference, not routine action)

The rebuild, smoke, rollback, and single-flight for a baked-pin merge are all the on-box `fluncle-pin-watch` timer's job (`docs/agents/hermes/pin-watch/`). Its shape: capture + keep the previous image → single-flight guard → rebuild from merged `main` → pre-smoke (versions, agent-tier read, role boundary) → swap → post-smoke → auto-rollback-and-alert on any failure. The **`fluncle-hermes-operator`** skill is the reference for the box's run/smoke mechanics that pin-watch encodes. The routine never drives those mechanics directly.

## When the box self-deploy does NOT apply

- **A BRAKE item** never reaches merge, so it never reaches the box — it's a report.
- **A base-image bump** is always a BRAKE: report the newer tag, let the operator pull it (the rebuild's failure mode there is the whole gateway, too coarse and too consequential to ship unattended even with pin-watch's pre-smoke safety).
- **box.ascii** is unpinnable; the pin-watch post-smoke re-verifies the conductor after any rebuild it does, but never bumps it.

## Public-repo rule (applies to every file in this skill)

**Never** inline in any committed file here: host names, IPs, secret values, `op://` paths, box SSH/`docker`/`box` commands, or local `/Users/...` filesystem paths. The operator's secret-bearing commands stay in the 1Password ops note + the `fluncle-hermes-operator` skill; the committed docs and this skill stay at the architecture / procedure level. (Same rule the `fluncle-hermes-operator` skill and the cron README hold.)
