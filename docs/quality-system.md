# Evidence-directed quality

Fluncle validates the minimum sufficient evidence for a change's dependency closure, then escalates conservatively. This policy is shared by local agents and GitHub Actions through `scripts/quality/classifier.mjs`; there is no second hand-maintained path table for CI. A selected lane is mandatory, an unknown path is a full-matrix change, and the stable protected check `Lint, Format, and Typecheck` cannot pass when either the core or public-flow job fails.

## Closure contract

`bun run quality:classify -- --base <base-sha> --head <head-sha>` prints the plan. Add `--output <file>` for `run-lane.mjs`, `--github-output <file>` in Actions, or `--force-full` for a backstop.

| Changed surface                                                                                            | Required evidence                                                                                                 | Public-web E2E                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/web`, a package in its transitive dependency closure, or web migrations                              | static policy, affected dependents' typecheck/tests/production build, append-only migration guard when applicable | full deterministic suite                       |
| `apps/cli`                                                                                                 | static policy and CLI package/dependent checks; shipping source also selects exact-SHA release eligibility        | no                                             |
| `apps/ssh`, `apps/dns`                                                                                     | static policy plus direct `gofmt`, `go vet`, `go build`, and `go test` owner                                      | no                                             |
| `apps/sonar`                                                                                               | static policy plus Rust format, clippy, release build, and tests; also selects exact-SHA musl release eligibility | no                                             |
| extension, mobile, Raycast, live, media, or video                                                          | static policy plus the changed package and every dependent                                                        | only if the dependency graph reaches web       |
| canonical skill source, generated agent copies, or `skills-lock.json`                                      | static policy plus deterministic regeneration/diff                                                                | no unless another selected surface requires it |
| repository scripts and agent hooks                                                                         | static policy plus script tests                                                                                   | no                                             |
| docs and named root documents                                                                              | static policy                                                                                                     | no                                             |
| release or workflow topology                                                                               | full matrix plus workflow syntax/topology tests                                                                   | yes                                            |
| lockfiles, root build/lint/type configuration, patches, shared tool configuration, or an unrecognized path | full matrix                                                                                                       | yes                                            |

The package graph is read from workspace manifests and selection walks reverse dependencies. The comparison uses full history and explicit base/head SHAs, including the pull request base rather than the synthetic merge ref. Scheduled and operator-dispatched Quality Checks are full backstops. Playwright's changed-test heuristic may be used for early local feedback, but it is never the CI authority.

Security retains separate full-history Gitleaks and dependency-audit workflows. Audit still produces the raw report and applies the repository's policy gate in separate invocations. These inexpensive policy contracts are not path-pruned.

## Local start early, join late

Agent edit hooks run `bun run quality:preflight -- start --quiet`. It fingerprints the resulting tracked worktree tree, every untracked path and file body, Node, and classifier configuration; the same bytes therefore keep one identity across unstaged, staged, and committed states. It starts selected leaves in the background and returns immediately. Repeated edits update the desired fingerprint instead of blocking the writer after each edit.

Independent lightweight leaves run in parallel. Package, script, and browser suites run as separate waves on the shared local host so their deadline-bearing tests do not compete for CPU; CI still runs core and browser evidence concurrently on separate hosted runners. A failed wave is recorded immediately and stops later work, making `status` actionable without wasting the remaining expensive evidence.

Use:

```sh
bun run quality:preflight -- start
bun run quality:preflight -- status
bun run quality:preflight -- join
```

`join` is the commit and handoff boundary and is also called by the Husky pre-commit hook when dependencies are present. If content changes while work is running, the old result is rejected and the worker converges on the new fingerprint. Failures print the owning lane's log. A successful result for any other fingerprint is never accepted.

## CI topology and measurement

Quality Checks has two parallel evidence jobs and one small aggregator. `core` owns static policy, migrations, affected TypeScript packages, scripts, skills, Go, Rust, and workflow topology. `e2e` either reports a cheap intentional skip or runs the complete isolated Turso-compatible public-flow contract. `Lint, Format, and Typecheck` always runs with `if: always()` and passes only when both owners succeeded, so branch protection keeps a stable context even for non-web changes.

Every selected lane writes its duration to a JSONL record and the Actions step summary through `measure.mjs` and `report-run.mjs`. The record includes the closure, first actionable failure, billed-minute projection, cache hit/bytes when available, and placeholders for confirmed real/flaky classification and full-backstop escapes. Post-deploy reporting separately records wait time and surface-sweep time. A future failure-triage automation may enrich the placeholders without changing lane authority.

`bun run quality:history -- --commits 120 --live` replays the classifier against first-parent history, reports full/E2E/unknown selections, applies hosted-runner per-job rounding, and refreshes live workflow/cache evidence. The timing model is committed in `scripts/quality/timing-model.json`; update it from a meaningful hosted sample when the topology or runner image materially changes. Current public hosted-runner concurrency is capacity rather than private-compute spend, while GitHub cache and artifact retention consume repository storage; the report keeps runner-minute and byte projections separate.

The 2026-09-01 baseline replay selected E2E for 77 of 120 commits and the fail-closed full matrix for 26. Under the committed timing model, the old two-job topology projected 1,920 p50 and 2,520 p90 rounded runner-minutes for that sample; the selected three-job topology projected 972 and 1,280 respectively, a 49.4%/49.2% reduction. Projected first feedback moved from 530/602 seconds to 353/574 seconds. Re-run the report instead of treating those numbers as permanent.

## Cache ownership

The Bun package cache is intentionally absent. In the 27-step hosted sample produced by the live history report, restore p50/p90 was 53/64 seconds while frozen-install p50/p90 was 5/7 seconds, so it increased latency before any validation began.

Turbo and Cargo use explicit restore/save actions. Pull-request merge refs restore only and never write. Trusted `main` writes at most one immutable snapshot per dependency hash and UTC week, with prefix restore from the newest prior epoch. This is a bounded rotating design rather than an invalid stable immutable key: it changes the former approximately one Turbo archive per SHA trajectory to at most one active archive per week per dependency lineage. GitHub's normal eviction bounds older snapshots; deleting existing caches is an operator action and is not part of repository rollout.

The live 2026-09-01 inventory contained 121 cache archives / 134,061,413,479 bytes, of which 113 / 128,525,098,920 bytes were Turbo archives. A fresh local CLI typecheck/test/build sample took 11.215 seconds cold and 0.366 seconds warm while producing a 225,547-byte Turbo snapshot. This confirms substantial reuse for the sampled lane, but the hosted restore/save metrics emitted by the new workflow remain the authority for whether the larger weekly snapshots have positive net benefit. Remove or narrow a snapshot class if its measured restore plus save cost exceeds the work avoided.

The Playwright browser cache is dependency-keyed, restores on selected web jobs, and writes only from trusted `main`. Each job reports cache outcome so retention is revisited when restore time plus storage no longer beats download/install time.

## Release validation reuse

`cli-release.yml` starts after a successful push-triggered Quality Checks completion and checks out `workflow_run.head_sha`, not the default-branch `GITHUB_SHA`. The selector compares that exact validated SHA with the relevant latest release tag. Manual dispatch accepts only a full SHA that is an ancestor of pushed `origin/main` and already has a successful push-triggered Quality run for the exact SHA.

Release jobs do not call Quality again. The CLI release still compiles and identifies four macOS/Linux arm64/x64 artifacts before publishing. The Sonar release still builds the locked `x86_64-unknown-linux-musl` target, proves the staged binary is static, and publishes its checksum and exact commit marker. Those are release-artifact proofs, not duplicated generic validation.

## Go ownership

The selected core lane is the sole Quality owner for both Go applications. For each affected app, it executes `gofmt`, `go vet`, `go build`, and `go test` exactly once through direct Go commands. Turbo no longer runs Go build/test and Quality no longer repeats them explicitly. Cloudflare's deploy gate retains its independent production-deploy boundary; it is not part of the GitHub Actions duplication count.

## Deploy completion and fallback

`deploy-watch-paths.json` is the canonical Cloudflare exclusion list. `deploy-watch.mjs verify`, classifier tests, and workflow topology tests prove that every excluded path skips the post-deploy job and every deploy-triggering or unknown path selects it. The workflow deliberately has no top-level path filter, so it always emits an outcome.

The repository contains an optional Queue consumer in `apps/ci-events`. It accepts only terminal Workers Builds events for the configured main branch and Worker, requires a full commit SHA and build UUID, and emits `cloudflare-workers-build` repository dispatches. The GitHub workflow treats failure and cancellation as immediate failures. A success waits briefly for `/api/v1/health` to report the exact SHA or a descendant, covering a coalesced deployment without accepting an unrelated commit. Queue delivery is at least once: a failed GitHub dispatch throws for Queue retry, the build UUID gives each retry a stable correlation key, duplicate terminal events converge through workflow concurrency, and a later Cloudflare retry has its own build UUID and run.

Every deployable `main` push retains a bounded 20-minute polling fallback until event delivery is proven externally. Event runs use a three-minute correlation bound. The actual public-surface sweep remains unchanged and starts only after commit correlation.

### Operator-only event rollout

Do not perform these steps from an unattended agent session:

1. Merge and push the repository change through the normal reviewed path. Do not change branch protection: confirm the required contexts remain `Lint, Format, and Typecheck` and `Scan git history for committed secrets`, then observe both on a non-web PR and a web PR.
2. In Cloudflare Workers Builds watch paths for `fluncle-web`, compare the committed output of `node scripts/quality/deploy-watch.mjs print` with the existing exclusion list. Apply a setting change only if the current list differs, then re-run `node scripts/quality/deploy-watch.mjs verify` locally.
3. From `apps/ci-events`, create the exact queues with `bunx wrangler queues create fluncle-workers-build-events` and `bunx wrangler queues create fluncle-workers-build-events-dead`. Do not rename them without changing and reviewing `wrangler.jsonc`.
4. Create a fine-grained GitHub token restricted to `mauricekleine/fluncle` with **Contents: write** and no other repository permission; that is the permission required by GitHub's repository-dispatch endpoint. From `apps/ci-events`, store it with `bunx wrangler secret put GITHUB_DISPATCH_TOKEN`, then deploy with `bunx wrangler deploy`. Never commit, pass on argv, or echo the token.
5. In the Cloudflare dashboard's Workers Builds event-subscription surface, create one Queue subscription for source Worker `fluncle-web`, branch `main`, destination `fluncle-workers-build-events`, and exactly the `succeeded`, `failed`, and `canceled` terminal event types. Do not subscribe started or queued events.
6. Prove one exact-SHA success, one failed build, one canceled build, a deliberately retried relay delivery, duplicate delivery of one build UUID, and two commits coalesced into a deployment whose reported SHA descends from the earlier commit. Record each Cloudflare event/build UUID and matching GitHub run.
7. Leave the push polling fallback enabled for an observation window that includes normal, failed, retried, and coalesced builds. Compare `deploy-wait` with `surface-probe` durations in each Actions summary and confirm no terminal build lacks an event-triggered run.
8. Only after that proof, make a separate reviewed repository change to retire or lengthen the polling fallback. Do not delete historical GitHub caches or artifacts without explicit operator authority; the new keys naturally stop per-SHA growth.

The event payload and retry semantics follow Cloudflare's [Workers Builds event schema](https://developers.cloudflare.com/workers/observability/events/events-reference/workers-builds/) and [Queues retry model](https://developers.cloudflare.com/queues/configuration/batching-retries/). The release trigger follows GitHub's [`workflow_run` contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), and rotating snapshots use the documented [restore/save cache pattern](https://github.com/actions/cache/blob/main/caching-strategies.md#reusing-cache-across-frequently-used-branches).

## Evidence retention

Successful named journey evidence (`front-door-scroll`, `track-journey`, `search-surface`, and `discovery-events`) is uploaded only for selected `main` web runs and retained for 30 days. Failed selected runs upload the full Playwright report, traces/test results, and synthetic-stack log for seven days. Successful PR reports and the old second 31–90-day evidence copy are no longer retained: they duplicated shipped evidence or had no named failure to diagnose. No test or public-flow assertion was removed.

## Extending the contract

Add a surface by updating the classifier and its table-driven tests first. Declare its direct lane, dependent closure, deploy-watch behavior, release eligibility, and unknown-path fallback. Add a focused fixture demonstrating selection and a neighboring fixture demonstrating intentional exclusion, then compare the focused lane with a forced-full run. Update workflow topology tests whenever an owner, context, cache, artifact, or trigger changes. A reduction is acceptable only when the lost evidence is named here or covered by an equally strong owner; public-web, migrations, security, and release artifacts fail closed when ownership is ambiguous.
